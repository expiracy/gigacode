import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectPackedArtifact, packageCommand, packArtifact } from "./check-package.ts"

export interface ReleaseMetadata {
  schemaVersion: 1
  name: "opencode-gigacode"
  version: string
  tag: "next" | "latest"
  filename: string
  commit: string
  integrity: string
  shasum: string
  size: number
  fileCount: number
  runtime: { bun: string; node: string; npm: string }
}

export async function describeReleaseArtifact(path: string, expectedVersion: string, commit: string, runtime: ReleaseMetadata["runtime"]): Promise<ReleaseMetadata> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Release metadata requires a full source commit SHA")
  if (!runtime || Object.keys(runtime).sort().join(",") !== "bun,node,npm" || Object.values(runtime).some(version => typeof version !== "string" || !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))) throw new Error("Release runtime metadata must contain Bun, Node and npm version numbers only")
  const { artifact, contents, bytes } = await inspectPackedArtifact(path)
  validateReleaseManifest(JSON.parse(await contents.get("package.json")!.text()), expectedVersion)
  await validateReleaseDocumentation(contents, expectedVersion)
  const filename = `opencode-gigacode-${expectedVersion}.tgz`
  if (basename(path) !== filename) throw new Error(`Release tarball filename must be ${filename}`)
  return {
    schemaVersion: 1, name: "opencode-gigacode", version: expectedVersion, tag: releaseChannel(expectedVersion), filename, commit,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"), size: bytes.length, fileCount: artifact.files.length, runtime,
  }
}

/** Stable versions use latest; numbered alpha/beta prereleases use next. */
export function releaseChannel(version: string): ReleaseMetadata["tag"] {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)\.(?:0|[1-9]\d*))?$/.test(version)) throw new Error("Release versions must be stable semantic versions or numbered alpha/beta prereleases")
  return version.includes("-") ? "next" : "latest"
}

/** Validate the package contract before preparing a release candidate. */
export function validateReleaseManifest(manifest: Record<string, any>, expectedVersion: string): void {
  if (manifest.private === true) throw new Error("A release artifact must not be private")
  if (manifest.name !== "opencode-gigacode" || manifest.version !== expectedVersion) throw new Error(`Package name must be opencode-gigacode and version must be ${expectedVersion}`)
  const tag = releaseChannel(expectedVersion)
  if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/" || manifest.publishConfig?.access !== "public" || manifest.publishConfig?.tag !== tag) throw new Error(`Release artifacts must target the public npm registry with tag ${tag}`)
  if (manifest.license !== "MIT") throw new Error("Release artifacts must declare the MIT licence")
}

export async function validateReleaseDocumentation(contents: Map<string, File>, expectedVersion: string): Promise<void> {
  const tag = releaseChannel(expectedVersion)
  for (const path of ["README.md", "docs/installation.md"]) {
    const text = await contents.get(path)?.text()
    if (!text?.includes(expectedVersion) || !text.includes(`opencode-gigacode@${tag}`)) throw new Error(`${path} must describe ${expectedVersion} on the ${tag} channel`)
    for (const match of text.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/opencode-gigacode@([^/\s)]+)/g)) {
      if (match[1] !== expectedVersion) throw new Error(`${path} refers to a different package version`)
    }
  }
  const changelog = await contents.get("CHANGELOG.md")?.text()
  if (/^##\s+(\S+)/m.exec(changelog ?? "")?.[1] !== expectedVersion) throw new Error("The first changelog entry must match the release version")
}
export async function verifyReleaseArtifact(directory: string, expectedVersion: string, expectedCommit: string): Promise<ReleaseMetadata> {
  releaseChannel(expectedVersion)
  const metadata = JSON.parse(await readFile(join(directory, "release.json"), "utf8")) as ReleaseMetadata
  if (!/^[a-f0-9]{40}$/.test(expectedCommit) || metadata.commit !== expectedCommit) throw new Error("Release source commit mismatch")
  const filename = `opencode-gigacode-${expectedVersion}.tgz`
  if (metadata.filename !== filename) throw new Error("Release artifact filename mismatch")
  const path = join(directory, filename)
  const bytes = await readFile(path)
  if (metadata.integrity !== `sha512-${createHash("sha512").update(bytes).digest("base64")}` || metadata.shasum !== createHash("sha1").update(bytes).digest("hex")) throw new Error("Release artifact integrity mismatch")
  const actual = await describeReleaseArtifact(path, expectedVersion, metadata.commit, metadata.runtime)
  for (const key of ["schemaVersion", "name", "version", "tag", "filename", "integrity", "shasum", "size", "fileCount"] as const) if (metadata[key] !== actual[key]) throw new Error(`Release metadata ${key} mismatch`)
  return actual
}

async function command(args: string[], directory: string): Promise<string> {
  const child = Bun.spawn(packageCommand(args), { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit !== 0) throw new Error(`${args.slice(0, 2).join(" ")} failed: ${stderr || stdout}`)
  return stdout.trim()
}

export function assertCleanSource(status: string): void {
  if (status.trim()) throw new Error("Release preparation requires a clean committed source checkout")
}

/** Build one candidate, record its exact bytes, and leave registry publication to a separate decision. */
export async function prepareReleaseArtifact(outputDirectory: string, expectedVersion: string, sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")): Promise<ReleaseMetadata> {
  const source = await realpath(sourceDirectory)
  validateReleaseManifest(JSON.parse(await readFile(join(source, "package.json"), "utf8")), expectedVersion)
  const output = existsSync(resolve(outputDirectory)) ? await realpath(resolve(outputDirectory)) : join(await realpath(dirname(resolve(outputDirectory))), basename(outputDirectory))
  const part = relative(source, output)
  if (!part || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)) throw new Error("Release output must be outside the source checkout")
  if (existsSync(output) && (await readdir(output)).length) throw new Error("Release output directory must be empty")
  const commit = await command(["git", "rev-parse", "HEAD"], source)
  const clean = async () => {
    assertCleanSource(await command(["git", "--no-optional-locks", "status", "--porcelain"], source))
  }
  await clean()
  const [node, npm] = await Promise.all([command(["node", "--version"], source), command(["npm", "--version"], source)])
  const work = await mkdtemp(join(dirname(output), ".gigacode-release-pack-"))
  try {
    const artifact = await packArtifact(source, work)
    const metadata = await describeReleaseArtifact(artifact.path, expectedVersion, commit, { bun: Bun.version, node, npm })
    await clean()
    if (await command(["git", "rev-parse", "HEAD"], source) !== commit) throw new Error("The source commit changed during release preparation")
    await mkdir(output, { recursive: true })
    await rename(artifact.path, join(output, metadata.filename))
    await writeFile(join(output, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" })
    return metadata
  } finally { await rm(work, { recursive: true, force: true }) }
}

if (import.meta.main) {
  try {
    const [action, directory, version, commit, ...extra] = Bun.argv.slice(2)
    if (!directory || !version || extra.length || action === "prepare" && commit || action === "verify" && !commit || !["prepare", "verify"].includes(action ?? "")) throw new Error("Usage: bun run scripts/release-artifact.ts prepare <outputdir> <expected-version> | verify <artifactdir> <expected-version> <expected-commit>")
    const metadata = action === "prepare" ? await prepareReleaseArtifact(directory, version) : await verifyReleaseArtifact(directory, version, commit!)
    console.log(JSON.stringify(metadata, null, 2))
  } catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1 }
}

