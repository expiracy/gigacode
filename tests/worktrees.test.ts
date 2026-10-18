import { afterAll, beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile, realpath, link, mkdir, readFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { parallelBaseline, captureWriter, integrationChanges, worktreeDirectory } from "../src/worktrees.ts"
import { OpenCodeAdapter } from "../src/opencode.ts"
import { Schema } from "effect"
import { manifest, digest } from "../src/workspace.ts"
import type { Run, Attempt, TaskSpec, Store, ParallelBaseline, WorktreeChange } from "../src/types.ts"

let gitProfile: string | undefined
let previousPath: string | undefined
const restorePath = () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
beforeAll(async () => {
  // The unit suite uses POSIX executable modes. On Windows retain native Git;
  // use WSL for these fixtures if the host has global Git filters configured.
  if (process.platform === "win32") return
  previousPath = process.env.PATH
  const git = Bun.which("git")
  if (!git) throw new Error("Git is required for worktree fixtures")
  gitProfile = await mkdtemp(join(await realpath(tmpdir()), "gigacode-isolated-git-"))
  try {
    const configuration = join(gitProfile, "empty.gitconfig")
    const bin = join(gitProfile, "bin")
    await mkdir(bin)
    await writeFile(configuration, "\n")
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const wrapper = join(bin, "git")
    // Production probes discard inherited GIT_* variables. Set only the fixture
    // config isolation after that boundary, preserving repository-local filters.
    await writeFile(wrapper, `#!/bin/sh\nGIT_CONFIG_GLOBAL=${quote(configuration)} GIT_CONFIG_NOSYSTEM=1 exec ${quote(git)} "$@"\n`)
    await chmod(wrapper, 0o755)
    process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter)
  } catch (error) {
    restorePath()
    await rm(gitProfile, { recursive: true, force: true })
    gitProfile = undefined
    throw error
  }
})
afterAll(async () => {
  if (!gitProfile) return
  restorePath()
  await rm(gitProfile, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "ultra-worktrees-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")))
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], { cwd: directory, env, encoding: "utf8" }).trim()
  git("init", "--initial-branch=main")
  git("config", "user.name", "GigaCode fixture")
  git("config", "user.email", "fixture@example.invalid")
  await writeFile(join(directory, "base.txt"), "baseline\n")
  git("add", "--", "base.txt")
  git("commit", "-m", "Fixture baseline")
  return { directory: await realpath(directory), git, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

function integrator(directory: string, baseline: ParallelBaseline, changes: WorktreeChange[]) {
  const integration = { id: "integration.1", role: "implementer", writes: true, ownedPaths: changes.map(change => change.path) } as TaskSpec
  const attempt = { id: "integrator", taskId: integration.id, sessionId: "integrator-session", status: "running", ownerEpoch: 1 } as Attempt
  const run = { id: "run", projectId: "project", directory, status: "running", ownerEpoch: 1, policy: [{ action: "*", resource: "*", effect: "allow" }], parallel: { baseline, integrationTaskId: integration.id }, tasks: [
    { spec: { id: "writer", writes: true, ownedPaths: integration.ownedPaths }, status: "succeeded", acceptedAttemptId: "writer-attempt", attempts: [{ id: "writer-attempt", status: "succeeded", worktree: { state: "settled", directory: "retained-worktree", changes } }] },
    { spec: integration, status: "running", attempts: [attempt] },
  ] } as unknown as Run
  const expected = integrationChanges(run).hash; run.parallel!.expectedHash = expected
  const calls: any[] = [], context = { sessionID: attempt.sessionId, messageID: "native-message", id: "native-call", agent: "gigacode-worker", signal: new AbortController().signal, async progress() {} } as any
  const write = { name: "write", input: Schema.Struct({ path: Schema.String, content: Schema.String }), async execute(input: any, native: any) { calls.push({ input, native }); await writeFile(input.path, input.content); return { output: {} } } }
  const read = { name: "read", input: Schema.Struct({ path: Schema.String }), async execute(input: any) { return { output: await readFile(input.path, "utf8") } } }
  const ctx = { location: { directory, project: { id: "project", commands: {} } }, session: { async get() { return { id: attempt.sessionId, projectID: "project", location: { directory } } } }, tool: { async list() { return [write, read] } } }
  const store = { list() { return [run] }, event() { return true } } as unknown as Store
  const adapter = new OpenCodeAdapter(ctx as any, store, {} as any)
  return { adapter, expected, calls, context, binding: { run, task: integration, attempt, role: "implementer" as const }, ctx }
}

test("parallel baseline freezes the clean root's exact committed revision and source manifest", async () => {
  const f = await fixture()
  try {
    expect(await parallelBaseline(f.directory)).toEqual({ commit: f.git("rev-parse", "HEAD"), ...await manifest(f.directory) })
    expect(f.git("status", "--porcelain")).toBe("")
  } finally { await f.cleanup() }
})

test("parallel admission preserves and rejects staged, unstaged and untracked source changes", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, "base.txt"), "user's staged work\n")
    f.git("add", "--", "base.txt")
    await writeFile(join(f.directory, "base.txt"), "user's unstaged work\n")
    await writeFile(join(f.directory, "new.txt"), "user's untracked work\n")
    const status = f.git("status", "--porcelain")
    const before = await manifest(f.directory)
    await expect(parallelBaseline(f.directory)).rejects.toThrow("clean committed")
    expect(await manifest(f.directory)).toEqual(before)
    expect(f.git("status", "--porcelain")).toBe(status)
  } finally { await f.cleanup() }
})

test("parallel admission refuses configured Git filters before a read-only status can execute them", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, ".gitattributes"), "base.txt filter=ultra-fixture\n")
    f.git("config", "filter.ultra-fixture.clean", "sh -c 'printf bypassed > .git/filter-side-effect; cat'")
    f.git("add", "--", ".gitattributes", "base.txt"); f.git("commit", "-m", "Filter fixture")
    const marker = join(f.directory, ".git", "filter-side-effect")
    await rm(marker, { force: true }); await writeFile(join(f.directory, "base.txt"), "baseline\n")
    await expect(parallelBaseline(f.directory)).rejects.toThrow("Git filters")
    await expect(readFile(marker)).rejects.toThrow()
  } finally { await f.cleanup() }
})

test("parallel admission rejects submodules before status can run their local clean filters", async () => {
  const f = await fixture(), sub = await fixture()
  try {
    await writeFile(join(sub.directory, ".gitattributes"), "base.txt filter=ultra-sub\n")
    sub.git("add", "--", ".gitattributes"); sub.git("commit", "-m", "Submodule attributes")
    f.git("-c", "protocol.file.allow=always", "submodule", "add", sub.directory, "sub")
    f.git("commit", "-m", "Submodule fixture")
    f.git("-C", "sub", "config", "filter.ultra-sub.clean", "sh -c 'printf bypassed > ../.git/sub-filter-side-effect; cat'")
    await writeFile(join(f.directory, "sub", "base.txt"), "baseline\n")
    await expect(parallelBaseline(f.directory)).rejects.toThrow("submodules")
    await expect(readFile(join(f.directory, ".git", "sub-filter-side-effect"))).rejects.toThrow()
  } finally { await f.cleanup(); await sub.cleanup() }
})

test("settled writers retain exact scoped text additions and modifications without changing the source", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory)
    const directory = join(f.directory, ".gigacode", "worktree")
    f.git("worktree", "add", "--detach", directory, baseline.commit)
    await writeFile(join(directory, "base.txt"), "worker modification\n")
    await writeFile(join(directory, "new.txt"), "worker addition\n")
    const after = await manifest(directory)
    const run = { directory: f.directory, parallel: { baseline } } as Run
    const attempt = { worktree: { directory, state: "ready" } } as Attempt
    const task = { ownedPaths: ["base.txt", "new.txt"] } as TaskSpec
    expect(await captureWriter(run, attempt, task)).toEqual([
      { path: "base.txt", beforeHash: baseline.files["base.txt"], afterHash: after.files["base.txt"], content: "worker modification\n" },
      { path: "new.txt", afterHash: after.files["new.txt"], content: "worker addition\n" },
    ])
    expect(await manifest(f.directory)).toEqual({ hash: baseline.hash, files: baseline.files })
  } finally { await f.cleanup() }
})

test("integration applies only the exact accepted text union through native write under its bound invocation", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), data = "native integrated addition\n"
    const native = integrator(f.directory, baseline, [{ path: "new.txt", afterHash: digest(data), content: data }])
    expect(await native.adapter.integrate(native.binding, native.context)).toBe(native.expected)
    expect(native.calls).toEqual([{ input: { path: join(f.directory, "new.txt"), content: data }, native: native.context }])
    expect((await manifest(f.directory)).hash).toBe(native.expected)
  } finally { await f.cleanup() }
})

test("capturing a hardlinked writer output refuses linked source data and leaves both checkouts intact", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), directory = join(f.directory, ".gigacode", "worktree")
    f.git("worktree", "add", "--detach", directory, baseline.commit)
    await link(join(f.directory, "base.txt"), join(directory, "linked.txt"))
    await expect(captureWriter({ directory: f.directory, parallel: { baseline } } as Run, { worktree: { directory, state: "ready" } } as Attempt, { ownedPaths: ["linked.txt"] } as TaskSpec)).rejects.toThrow("hardlink")
    expect((await manifest(f.directory)).hash).toBe(baseline.hash)
    expect((await manifest(directory)).files["linked.txt"]).toBe(baseline.files["base.txt"]!)
  } finally { await f.cleanup() }
})

test("capture refuses mode-only edits even when repository filemode tracking is disabled", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), directory = join(f.directory, ".gigacode", "worktree")
    f.git("config", "core.filemode", "false"); f.git("worktree", "add", "--detach", directory, baseline.commit)
    await chmod(join(directory, "base.txt"), 0o755)
    await expect(captureWriter({ directory: f.directory, parallel: { baseline } } as Run, { worktree: { directory, state: "ready" } } as Attempt, { ownedPaths: ["base.txt"] } as TaskSpec)).rejects.toThrow("mode changes")
  } finally { await f.cleanup() }
})

test("capture refuses requested changes to tracked files excluded by the shared source manifest", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.directory, "build")); await writeFile(join(f.directory, "build", "script.txt"), "before\n")
    f.git("add", "--", "build/script.txt"); f.git("commit", "-m", "Tracked build source")
    const baseline = await parallelBaseline(f.directory), directory = join(f.directory, ".gigacode", "worktree")
    f.git("worktree", "add", "--detach", directory, baseline.commit)
    await writeFile(join(directory, "build", "script.txt"), "requested change\n")
    await expect(captureWriter({ directory: f.directory, parallel: { baseline } } as Run, { worktree: { directory, state: "ready" } } as Attempt, { ownedPaths: ["build/script.txt"] } as TaskSpec)).rejects.toThrow("excluded from the source manifest")
    expect(await readFile(join(directory, "build", "script.txt"), "utf8")).toBe("requested change\n")
    expect(await readFile(join(f.directory, "build", "script.txt"), "utf8")).toBe("before\n")
  } finally { await f.cleanup() }
})

test("capture refuses ignored untracked writer output instead of silently losing it", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, ".gitignore"), "dist/\n"); f.git("add", "--", ".gitignore"); f.git("commit", "-m", "Ignored output fixture")
    const baseline = await parallelBaseline(f.directory), directory = join(f.directory, ".gigacode", "worktree")
    f.git("worktree", "add", "--detach", directory, baseline.commit)
    await mkdir(join(directory, "dist")); await writeFile(join(directory, "dist", "output.txt"), "requested output\n")
    await expect(captureWriter({ directory: f.directory, parallel: { baseline } } as Run, { worktree: { directory, state: "ready" } } as Attempt, { ownedPaths: ["dist/output.txt"] } as TaskSpec)).rejects.toThrow("excluded from the source manifest")
    expect(await readFile(join(directory, "dist", "output.txt"), "utf8")).toBe("requested output\n")
  } finally { await f.cleanup() }
})

test("integration refuses existing root hardlinks before any native write can modify linked data", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), content = "updated text\n"
    const native = integrator(f.directory, baseline, [{ path: "base.txt", beforeHash: baseline.files["base.txt"], afterHash: digest(content), content }])
    await mkdir(join(f.directory, ".gigacode"))
    const linked = join(f.directory, ".gigacode", "linked-base.txt")
    await link(join(f.directory, "base.txt"), linked)
    await expect(native.adapter.integrate(native.binding, native.context)).rejects.toThrow("hardlink")
    expect(native.calls).toEqual([])
    expect(await readFile(linked, "utf8")).toBe("baseline\n")
    expect((await manifest(f.directory)).hash).toBe(baseline.hash)
  } finally { await f.cleanup() }
})

test("integration rechecks target links after native read permission waits", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), content = "changed\n"
    const native = integrator(f.directory, baseline, [{ path: "base.txt", beforeHash: baseline.files["base.txt"], afterHash: digest(content), content }])
    const read = (await native.ctx.tool.list()).find(tool => tool.name === "read")!
    const execute = read.execute
    await mkdir(join(f.directory, ".gigacode")); const alias = join(f.directory, ".gigacode", "late-link")
    read.execute = async (input: any, context: any) => { await link(join(f.directory, "base.txt"), alias); return execute(input, context) }
    await expect(native.adapter.integrate(native.binding, native.context)).rejects.toThrow("hardlink")
    expect(native.calls).toEqual([])
    expect(await readFile(alias, "utf8")).toBe("baseline\n")
  } finally { await f.cleanup() }
})

test("file-versus-directory writer conflicts are rejected before any native root write", async () => {
  const f = await fixture()
  try {
    const baseline = await parallelBaseline(f.directory), first = "file\n", second = "nested file\n"
    const native = integrator(f.directory, baseline, [{ path: "new", afterHash: digest(first), content: first }])
    native.binding.run.tasks.push({ spec: { id: "other-writer", writes: true, ownedPaths: ["new/child.txt"] } as TaskSpec, status: "succeeded", acceptedAttemptId: "other-attempt", attempts: [{ id: "other-attempt", status: "succeeded", worktree: { directory: "retained-second", state: "settled", changes: [{ path: "new/child.txt", afterHash: digest(second), content: second }] } } as Attempt] })
    expect(() => integrationChanges(native.binding.run)).toThrow("conflict")
    await expect(native.adapter.integrate(native.binding, native.context)).rejects.toThrow("conflict")
    expect(native.calls).toEqual([])
    expect((await manifest(f.directory)).hash).toBe(baseline.hash)
  } finally { await f.cleanup() }
})

test("preparation creates the saved checkout only through the bound fixed native Git invocation and registers it", async () => {
  const f = await fixture()
  try {
    const hook = "#!/bin/sh\nprintf 'hook unexpectedly ran' > hook-ran.txt\n"
    await writeFile(join(f.directory, "post-checkout"), hook); await chmod(join(f.directory, "post-checkout"), 0o755)
    f.git("add", "--", "post-checkout"); f.git("commit", "-m", "Add hostile checkout hook fixture")
    await writeFile(join(f.directory, ".git", "hooks", "post-checkout"), hook); await chmod(join(f.directory, ".git", "hooks", "post-checkout"), 0o755)
    const baseline = await parallelBaseline(f.directory), runId = "run_" + "a".repeat(32)
    const task = { id: "preparation.1", role: "implementer", writes: true, ownedPaths: ["new.txt"] } as TaskSpec
    const attempt = { id: "prepare-attempt", taskId: task.id, sessionId: "prepare-session", status: "running", ownerEpoch: 1 } as Attempt
    const run = { id: runId, projectId: "project", directory: f.directory, status: "running", ownerEpoch: 1, policy: [{ action: "*", resource: "*", effect: "allow" }], tasks: [{ spec: task, status: "running", attempts: [attempt] }], parallel: { baseline, preparationTaskId: task.id, integrationTaskId: "integration.1", checkouts: [] } } as unknown as Run
    const directory = worktreeDirectory(run, { taskId: "writer", number: 1 })
    run.parallel!.checkouts.push({ taskId: "writer", directory, state: "planned" })
    const context = { sessionID: attempt.sessionId, messageID: "prepare-message", id: "prepare-call", agent: "gigacode-worker", signal: new AbortController().signal, async progress() {} } as any
    const calls: any[] = [], order: string[] = []
    const shell = { name: "shell", input: Schema.Struct({ command: Schema.String, background: Schema.Boolean, timeout: Schema.Number }), async execute(input: any, native: any) { calls.push({ input, native }); order.push("native-shell"); f.git(...input.command.split(" ").slice(1)); return { output: { exit: 0, status: "completed" } } } }
    const ctx = { location: { directory: f.directory, project: { id: "project" } }, session: { async get() { return { projectID: "project", location: { directory: f.directory } } } }, tool: { async list() { return [shell] } }, worktree: { async create() { throw new Error("Unsafe native worktree create must never run") }, async refresh() { order.push("refresh") }, async list() { return [{ directory }] } } }
    const store = { list() { return [run] }, event() { return true } } as unknown as Store
    const adapter = new OpenCodeAdapter(ctx as any, store, {} as any)
    await adapter.prepare({ run, task, attempt, role: "implementer" }, context)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.native).toBe(context)
    expect(calls[0]!.input.command).toMatch(/^git -c core\.hooksPath=\.gigacode\/empty-hooks\/[a-f0-9]+ -c core\.fsmonitor=false worktree add --detach \.gigacode\/worktrees\/run_[a-f0-9]+\/[a-f0-9]+-1 [a-f0-9]{40}$/)
    expect(order).toEqual(["native-shell", "refresh"])
    expect((await manifest(directory)).hash).toBe(baseline.hash)
    expect((await manifest(directory)).files["hook-ran.txt"]).toBeUndefined()
    expect((await manifest(f.directory)).hash).toBe(baseline.hash)
  } finally { await f.cleanup() }
})
