import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { changedPaths, digest, inside, manifest } from "./workspace.ts"
import { restrictPermission } from "./policy.ts"
import { runtimeDirectory, runtimeName } from "./paths.ts"
import type { ParallelBaseline, Run, Attempt, TaskSpec, WorktreeChange } from "./types.ts"

const execute = promisify(execFile)
export async function readGit(directory: string, args: string[]): Promise<string> {
  // Read-only Git probes must not run repository diff drivers or filesystem monitors.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")))
  const result = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args], { cwd: directory, env, timeout: 10_000, maxBuffer: 8_000_000 })
  return result.stdout
}

async function assertNoFilters(directory: string): Promise<void> {
  let configured: string
  try { configured = await readGit(directory, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"]) }
  catch (error) { if ((error as { code?: unknown }).code === 1) return; throw error }
  if (configured.trim()) throw new Error("Parallel writers do not support configured Git filters; existing files were preserved")
}

async function assertNoSubmodules(directory: string, commit: string): Promise<void> {
  const [tree, index] = await Promise.all([readGit(directory, ["ls-tree", "-rz", commit]), readGit(directory, ["ls-files", "--stage", "-z"])])
  if ([...tree.split("\0"), ...index.split("\0")].some(entry => entry.startsWith("160000 "))) throw new Error("Parallel writers do not support Git submodules; existing files were preserved")
}

export async function parallelBaseline(directory: string): Promise<ParallelBaseline> {
  const root = await realpath(directory)
  const gitRoot = await realpath((await readGit(root, ["rev-parse", "--show-toplevel"])).trim())
  if (resolve(root) !== resolve(gitRoot)) throw new Error("Parallel writers require the canonical Git root")
  const commit = (await readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  await assertNoFilters(root)
  await assertNoSubmodules(root, commit)
  const dirty = (await readGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0").filter(Boolean)
  if (dirty.some(entry => !entry.slice(3).replaceAll("\\", "/").startsWith(`${runtimeName}/`))) throw new Error("Parallel writers require a clean committed Git baseline; existing changes were preserved")
  return { commit, ...await manifest(root) }
}

export function worktreeDirectory(run: Run, attempt: Pick<Attempt, "taskId" | "number">): string {
  return join(runtimeDirectory(run.directory), "worktrees", run.id, `${digest(attempt.taskId).slice(0, 16)}-${attempt.number}`)
}

export async function captureWriter(run: Run, attempt: Attempt, task: TaskSpec): Promise<WorktreeChange[]> {
  if (!run.parallel || !attempt.worktree) throw new Error("Writer has no recorded worktree")
  const { baseline } = run.parallel, { directory } = attempt.worktree
  await assertNoFilters(directory)
  await assertNoSubmodules(directory, baseline.commit)
  if ((await readGit(directory, ["rev-parse", "HEAD"])).trim() !== baseline.commit) throw new Error("Writer changed its frozen Git revision")
  if ((await readGit(directory, ["-c", "core.filemode=true", "diff", "--no-ext-diff", "--no-textconv", "--summary", baseline.commit])).includes(" mode change ")) throw new Error("Parallel integration does not support mode changes; worktree retained")
  const after = await manifest(directory)
  const observed = (await Promise.all([
    readGit(directory, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", baseline.commit]),
    readGit(directory, ["ls-files", "--others", "--exclude-standard", "-z"]),
    readGit(directory, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ])).flatMap(value => value.split("\0").filter(Boolean))
  for (const path of observed) if (!path.split("/").includes(runtimeName) && !baseline.files[path] && !after.files[path]) throw new Error(`Parallel writer changed a file excluded from the source manifest: ${path}; worktree retained`)
  const modes = new Map((await readGit(directory, ["ls-tree", "-rz", baseline.commit])).split("\0").filter(Boolean).map(entry => {
    const split = entry.indexOf("\t")
    return [entry.slice(split + 1), entry.slice(0, 6)]
  }))
  const changes: WorktreeChange[] = []
  let bytes = 0
  for (const path of changedPaths(baseline, after)) {
    if (restrictPermission("allow", [{ action: "*", resource: "*", effect: "allow" }], "implementer", "write", [path], task.ownedPaths, directory) !== "allow") throw new Error(`Writer changed a path outside its owned scope: ${path}`)
    if (!after.files[path]) throw new Error(`Parallel integration does not support deleted files: ${path}; worktree retained`)
    const absolute = join(directory, path), info = await lstat(absolute)
    if (!info.isFile() || !inside(directory, await realpath(absolute))) throw new Error(`Parallel integration does not support symlinks: ${path}; worktree retained`)
    if (info.nlink !== 1) throw new Error(`Parallel integration does not support hardlinks: ${path}; worktree retained`)
    const mode = info.mode & 0o111 ? "100755" : "100644"
    if (mode !== (modes.get(path) ?? "100644")) throw new Error(`Parallel integration does not support mode changes: ${path}; worktree retained`)
    const data = await readFile(absolute), content = data.toString("utf8")
    bytes += data.length
    if (bytes > 2_000_000) throw new Error("Parallel writer changes exceed the 2 MB retained-text limit; worktree retained")
    if (data.includes(0) || !Buffer.from(content).equals(data)) throw new Error(`Parallel integration does not support binary files: ${path}; worktree retained`)
    if (digest(content) !== after.files[path]) throw new Error(`Writer files changed during capture: ${path}`)
    changes.push({ path, ...(baseline.files[path] ? { beforeHash: baseline.files[path] } : {}), afterHash: after.files[path]!, content })
  }
  if (await manifest(directory).then(value => value.hash) !== after.hash) throw new Error("Writer files changed during capture")
  return changes
}

export function integrationChanges(run: Run): { changes: WorktreeChange[]; hash: string } {
  if (!run.parallel) throw new Error("Run has no parallel baseline")
  const files = { ...run.parallel.baseline.files }, changes: WorktreeChange[] = [], seen = new Set<string>()
  for (const task of run.tasks.filter(task => task.spec.writes && task.spec.id !== run.parallel!.integrationTaskId && task.spec.id !== run.parallel!.preparationTaskId)) {
    const attempt = task.attempts.find(attempt => attempt.id === task.acceptedAttemptId)
    if (task.status !== "succeeded" || attempt?.status !== "succeeded" || attempt.worktree?.state !== "settled" || !attempt.worktree.changes) throw new Error(`Isolated writer ${task.spec.id} has no accepted immutable changes`)
    for (const change of attempt.worktree.changes) {
      const name = process.platform === "win32" || process.platform === "darwin" ? change.path.toLowerCase() : change.path
      if (seen.has(name + "/")) throw new Error(`Parallel integration conflict: overlapping changed path ${change.path}; worktrees retained`)
      if (change.beforeHash !== run.parallel.baseline.files[change.path] || digest(change.content) !== change.afterHash) throw new Error(`Captured writer changes do not match the frozen baseline: ${change.path}`)
      seen.add(name + "/"); files[change.path] = change.afterHash; changes.push(change)
    }
  }
  const paths = [...seen].sort()
  for (let index = 1; index < paths.length; index++) if (paths[index]!.startsWith(paths[index - 1]!)) throw new Error(`Parallel integration conflict: file and directory paths overlap at ${paths[index]}; worktrees retained`)
  return { changes, hash: digest(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))) }
}
