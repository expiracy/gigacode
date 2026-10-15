import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { CompatibilityRpc } from "./rpc.ts"
import { type IsolatedHost, waitFor } from "./host.ts"

function contained(root: string, target: string): void {
  const path = relative(resolve(root), resolve(target))
  assert(path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path), `Fixture path escaped its root: ${target}`)
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === ""
}

function errorEvidence(error: unknown): { name: string; message: string; forceRequired?: boolean } {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; type?: unknown; message?: unknown; data?: { message?: unknown; forceRequired?: unknown } }
    return {
      name: String(value.name ?? value.type ?? "UnknownError"),
      message: String(value.data?.message ?? value.message ?? "Remote operation rejected"),
      ...(typeof value.data?.forceRequired === "boolean" ? { forceRequired: value.data.forceRequired } : {}),
    }
  }
  return { name: "UnknownError", message: String(error) }
}

async function mustReject(description: string, operation: () => Promise<unknown>) {
  try {
    await operation()
  } catch (error) {
    return { rejected: true, error: errorEvidence(error) }
  }
  throw new Error(`Expected rejection: ${description}`)
}

/** Native Git worktrees and session placement, entirely inside a disposable fixture. */
export async function probeWorktree(host: IsolatedHost): Promise<object> {
  const fixtureRoot = await realpath(host.root)
  const probeRoot = await mkdtemp(join(fixtureRoot, "worktree-probe-"))
  contained(fixtureRoot, await realpath(probeRoot))
  const source = join(probeRoot, "source")
  const foreign = join(probeRoot, "foreign")
  const destinations = join(probeRoot, "worktrees")
  const gitHome = join(probeRoot, "git-home")
  const noHooks = join(probeRoot, "no-hooks")
  for (const directory of [source, foreign, destinations, gitHome, noHooks]) {
    contained(fixtureRoot, directory)
    await mkdir(directory, { recursive: true })
  }
  const emptyGitConfig = join(probeRoot, "empty.gitconfig")
  await writeFile(emptyGitConfig, "\n")
  const git = Bun.which("git")
  assert(git, "Git must be installed to exercise native worktrees")
  const environment: Record<string, string> = {}
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS"]) {
    if (process.env[name]) environment[name] = process.env[name]!
  }
  Object.assign(environment, {
    USERPROFILE: gitHome,
    XDG_CONFIG_HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "UltraOpenCode compatibility fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "UltraOpenCode compatibility fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    TEMP: join(host.root, "tmp"),
    TMP: join(host.root, "tmp"),
    TMPDIR: join(host.root, "tmp"),
  })
  const runGit = async (directory: string, arguments_: string[]) => {
    contained(fixtureRoot, await realpath(directory))
    const process_ = Bun.spawn([git, "-c", "core.hooksPath=" + noHooks, "-c", "commit.gpgsign=false", ...arguments_], {
      cwd: directory,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      timeout: 10_000,
    })
    const [exitCode, output, error] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ])
    assert.equal(exitCode, 0, `Fixture Git failed: ${arguments_.join(" ")}: ${error}`)
    return output.trim()
  }
  // Resolve these locations only AFTER their first commits; markerless locations can be cached.
  for (const [directory, label] of [[source, "source"], [foreign, "foreign"]] as const) {
    await runGit(directory, ["init", "--initial-branch=main"])
    await runGit(directory, ["config", "core.hooksPath", noHooks])
    await runGit(directory, ["config", "core.fsmonitor", "false"])
    await runGit(directory, ["config", "core.autocrlf", "false"])
    await writeFile(join(directory, "fixture.txt"), `${label} ${crypto.randomUUID()}\n`)
    await runGit(directory, ["add", "--", "fixture.txt"])
    await runGit(directory, ["commit", "--no-gpg-sign", "-m", "Initialize isolated compatibility fixture"])
  }
  const head = await runGit(source, ["rev-parse", "HEAD"])
  const originalContent = await readFile(join(source, "fixture.txt"), "utf8")
  const location = await host.client.location.get({ location: { directory: source } })
  assert(samePath(location.directory, source), "Source location was not respected")
  assert(samePath(location.project.directory, source), "Source project did not discover the fresh Git repository")
  const projectID = location.project.id
  const parent = await host.client.session.create({
    location: { directory: source },
    title: "Worktree compatibility parent",
    model: { providerID: "fixture", id: "test" },
  })
  // Prompt preparation activates the location's plugin registry without dispatching a model request.
  await host.client.session.prompt({ sessionID: parent.id, text: "WORKTREE_LOCATION_ACTIVATION", resume: false })
  const sourceRpc = host.client.rpc(CompatibilityRpc)
  const rpcOptions = { location: { directory: source }, signal: AbortSignal.timeout(10_000) }
  const sourceInspection = await sourceRpc.inspect({}, rpcOptions) as Record<string, unknown>
  assert.equal(sourceInspection.projectID, projectID, "RPC resolved a different source project")
  await sourceRpc.claim({ sessionID: parent.id }, rpcOptions)
  const sourceVcs = await host.client.vcs.get({ location: { directory: source } })
  assert.equal(sourceVcs.data.provider, "git")
  assert.equal(sourceVcs.data.branch.current, "main")

  {
    const before = await host.client.worktree.list({ projectID })
    const created = await host.client.worktree.create({
      projectID,
      from: source,
      branch: "main",
      directory: destinations,
      name: "worker",
    }, { signal: AbortSignal.timeout(15_000) })
    const worktree = await realpath(created.directory)
    contained(fixtureRoot, worktree)
    assert(samePath(worktree, join(destinations, "worker")), "Worktree destination/name semantics changed")
    const listing = await host.client.worktree.list({ projectID })
    assert(listing.some(entry => samePath(entry.directory, worktree!)), "Created worktree was not registered")
    await host.client.worktree.refresh({ projectID })
    const refreshed = await host.client.worktree.list({ projectID })
    assert(refreshed.some(entry => samePath(entry.directory, worktree!)), "Refresh lost the managed worktree")
    assert.equal(await readFile(join(worktree, "fixture.txt"), "utf8"), originalContent, "Worktree did not contain the requested source revision")
    const worktreeHead = await runGit(worktree, ["rev-parse", "HEAD"])
    assert.equal(worktreeHead, head)
    const destination = await host.client.location.get({ location: { directory: worktree } })
    assert.equal(destination.project.id, projectID, "Worktree must retain the original native project identity")

    const child = await host.client.session.create({
      parentID: parent.id,
      location: { directory: worktree },
      title: "Worktree compatibility child",
    })
    assert.equal(child.parentID, parent.id)
    assert(samePath(child.location.directory, source), "Child creation must inherit parent placement even with an explicit location")
    await sourceRpc.claim({ sessionID: child.id }, rpcOptions)
    await host.client.session.move({ sessionID: child.id, directory: worktree, delivery: "queue" })
    const moved = await waitFor("worktree session placement", () => host.client.session.get({ sessionID: child.id }), value => samePath(value.location.directory, worktree!))
    await host.client.session.wait({ sessionID: child.id }, { signal: AbortSignal.timeout(15_000) })
    const settled = await host.client.session.get({ sessionID: child.id })
    assert.equal(settled.parentID, parent.id)
    assert.equal(settled.projectID, projectID)
    assert(samePath(settled.location.directory, worktree))
    const wrongLocation = await mustReject("source plugin claiming moved child", () => sourceRpc.claim({ sessionID: child.id }, rpcOptions))
    // Prove the source RPC remains healthy after rejection; a missing plugin is not ownership evidence.
    await sourceRpc.claim({ sessionID: parent.id }, rpcOptions)
    const destinationActivation = await host.client.session.create({
      location: { directory: worktree },
      title: "Worktree location activation fixture",
      model: { providerID: "fixture", id: "test" },
    })
    await host.client.session.prompt({ sessionID: destinationActivation.id, text: "WORKTREE_DESTINATION_ACTIVATION", resume: false })
    const destinationOptions = { location: { directory: worktree }, signal: AbortSignal.timeout(10_000) }
    const destinationInspection = await sourceRpc.inspect({}, destinationOptions) as Record<string, unknown>
    assert.equal(destinationInspection.projectID, projectID)
    assert(samePath(String(destinationInspection.directory), worktree))
    const destinationClaim = await sourceRpc.claim({ sessionID: child.id }, destinationOptions) as Record<string, unknown>
    assert.equal(destinationClaim.bound, true)
    const worktreeVcs = await host.client.vcs.get({ location: { directory: worktree } })
    assert.equal(worktreeVcs.data.provider, "git")
    assert.equal(worktreeVcs.data.branch.current, undefined, "Pinned native worktree creation must use a detached HEAD")

    const foreignSession = await host.client.session.create({ location: { directory: foreign }, title: "Foreign ownership fixture" })
    assert.notEqual(foreignSession.projectID, projectID, "Distinct fixture commits must yield different native project identities")
    const wrongProject = await mustReject("source plugin claiming foreign-project session", () => sourceRpc.claim({ sessionID: foreignSession.id }, rpcOptions))
    await sourceRpc.claim({ sessionID: parent.id }, rpcOptions)
    const sourceSnapshot = await sourceRpc.snapshot({}, rpcOptions) as { sessions: { id: string }[] }
    assert(!sourceSnapshot.sessions.some(session => session.id === foreignSession.id), "Rejected foreign session was nevertheless bound")

    type Row = { kind: string; session_id: string | null; event_id: string | null; data: { data?: { title?: string } } }
    const sourceHistory = async () => (await sourceRpc.history({}, { location: { directory: source } }) as { events: Row[] }).events
    const destinationHistory = async () => (await sourceRpc.history({}, { location: { directory: worktree } }) as { events: Row[] }).events
    const destinationTitle = `WORKTREE_ONLY_${crypto.randomUUID()}`
    const foreignTitle = `FOREIGN_ONLY_${crypto.randomUUID()}`
    const barrierTitle = `SOURCE_FILTER_BARRIER_${crypto.randomUUID()}`
    await host.client.session.update({ sessionID: child.id, title: destinationTitle })
    const destinationRows = await waitFor("destination plugin observes its owned worktree event", destinationHistory, rows => rows.some(row => row.kind === "session.renamed" && row.data.data?.title === destinationTitle))
    await host.client.session.update({ sessionID: foreignSession.id, title: foreignTitle })
    await host.client.session.update({ sessionID: parent.id, title: barrierTitle })
    const sourceRows = await waitFor("source event filter barrier", sourceHistory, rows => rows.some(row => row.kind === "session.renamed" && row.data.data?.title === barrierTitle))
    assert(!sourceRows.some(row => row.kind === "session.renamed" && row.data.data?.title === destinationTitle), "Source plugin accepted a same-project event from a different worktree")
    assert(!sourceRows.some(row => row.session_id === foreignSession.id), "Source plugin accepted an unowned foreign-project event")
    const foreignProjection = await host.client.session.get({ sessionID: foreignSession.id })
    assert.equal(foreignProjection.title, foreignTitle, "Foreign-event exclusion needs proof that the native rename committed")

    const nativeMoveEvents = []
    for await (const event of host.client.session.log({ sessionID: child.id, follow: false }, { signal: AbortSignal.timeout(10_000) })) {
      if (event.type === "session.moved") nativeMoveEvents.push(event)
    }
    const nativeMoveReplayAvailable = nativeMoveEvents.some(event => samePath(event.data.location.directory, worktree))

    await writeFile(join(worktree, "fixture.txt"), "Only this disposable worktree changed.\n")
    assert.equal(await readFile(join(source, "fixture.txt"), "utf8"), originalContent, "Worktree changes leaked into the source checkout")
    const status = await host.client.vcs.status({ location: { directory: worktree } })
    assert(status.data.some(file => file.file === "fixture.txt" && file.status === "modified"), "Native VCS status did not observe the worktree's isolated edit")
    const dirtyRemoval = await mustReject("dirty worktree removal without force", () => host.client.worktree.remove({ projectID, directory: worktree!, force: false }))
    assert.equal(dirtyRemoval.error.forceRequired, true, "Native rejection did not identify dirty worktree protection")
    assert((await stat(worktree)).isDirectory(), "Rejected removal must preserve the dirty worktree")

    return {
      source: location,
      sourceVcs: sourceVcs.data,
      worktree: destination,
      worktreeVcs: worktreeVcs.data,
      sourceHead: head,
      worktreeHead,
      before,
      listing,
      refreshed,
      sessions: { parent: parent.id, child: child.id, destinationActivation: destinationActivation.id, foreign: foreignSession.id, foreignProjectID: foreignSession.projectID },
      inheritedPlacement: child.location,
      movedPlacement: moved.location,
      settledPlacement: settled.location,
      nativeMoveEvents,
      nativeMoveReplayAvailable,
      ownership: { wrongLocation, wrongProject, destinationClaim },
      eventExclusion: { sourceBarrier: barrierTitle, worktreeEvent: destinationRows.find(row => row.data.data?.title === destinationTitle), foreignProjection: { id: foreignProjection.id, title: foreignProjection.title }, foreignProjectExcluded: true, sameProjectDifferentLocationExcluded: true },
      isolatedChange: { sourceUnchanged: true, status: status.data },
      dirtyRemoval,
      preserved: { directory: worktree, reason: "Keep the isolated change and native registration available for inspection; no force removal was performed." },
      limits: ["Session placement used an API-created child, not the native subagent prelaunch callback.", "Only inert activation prompts were admitted with resume:false; no generated agent code ran in the worktree.", "The spike's location ownership check is an adapter guard; native API authentication is server-wide.", ...(!nativeMoveReplayAvailable ? ["CLI native event payload persistence is disabled; session.move is verified through native projection and location observers, not durable log replay."] : [])],
    }
  }
}
