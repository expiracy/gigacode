import assert from "node:assert/strict"
import { existsSync, lstatSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Verify the file list reported by npm pack before running installed smoke checks. */
export function assertPackageContents(files: string[]): void {
  const allowed = /^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE(?:\.md)?|index\.ts|tui\.ts|scripts\/(?:cli|install|doctor)\.ts|src\/[a-z0-9-]+\.ts|examples\/[a-z0-9-]+\.json|docs\/(?:installation|configuration|commands|development|architecture|agent-workflows)\.md|docs\/assets\/(?:README\.md|(?:workspace|workflows|settings)\.png|logo(?:-dark|-light)?\.svg))$/
  for (const path of files) if (!allowed.test(path)) throw new Error(`Unexpected packaged file: ${path}`)
  for (const path of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "index.ts", "tui.ts", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts", "src/plugin.ts", "src/config.ts"]) {
    if (!files.includes(path)) throw new Error(`Missing packaged file: ${path}`)
  }
}

/** Accept the licence title independently of checkout line-ending conversion. */
export function assertMITLicense(source: string): void {
  assert.match(source, /^MIT License\r?\n/, "Packaged LICENSE must begin with the MIT License title")
}

export interface PackedArtifact { path: string; files: string[]; size: number }
type PackedInstallation = Awaited<ReturnType<typeof preparePackedInstallation>>

/** npm is a command script on Windows and needs the command interpreter. */
export function packageCommand(args: string[], platform = process.platform): string[] {
  return platform === "win32" && args[0] === "npm" ? ["cmd.exe", "/d", "/s", "/c", "npm.cmd", ...args.slice(1)] : args
}

async function command(args: string[], cwd: string, env: Record<string, string | undefined> = process.env, expectedExit = 0): Promise<string> {
  const child = Bun.spawn(packageCommand(args), { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 120_000 })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit !== expectedExit) throw new Error(`${args.slice(0, 2).join(" ")} exited ${exit}, expected ${expectedExit}:\n${stderr || stdout}`)
  return stdout
}

/** Read package files in memory; no archive paths are extracted to disk. */
export async function inspectPackedArtifact(path: string) {
  const bytes = await readFile(path)
  const contents = new Map<string, File>()
  for (const [name, file] of await new Bun.Archive(bytes).files()) {
    if (!name.startsWith("package/") || name.includes("\\") || name.split("/").some(part => part === "." || part === ".." || !part)) throw new Error(`Unsafe package archive path: ${name}`)
    contents.set(name.slice("package/".length), file)
  }
  assertPackageContents([...contents.keys()])
  const manifest = JSON.parse(await contents.get("package.json")!.text())
  assert.equal(manifest.name, "opencode-gigacode", "The supplied artifact must contain opencode-gigacode")
  assertMITLicense(await contents.get("LICENSE")!.text())
  return { artifact: { path: await realpath(path), files: [...contents.keys()].sort(), size: bytes.length }, contents, bytes }
}

/** The native integration imports this helper so it exercises the same tarball. */
export async function packArtifact(source: string, destination: string): Promise<PackedArtifact> {
  await mkdir(destination, { recursive: true })
  const packed = JSON.parse(await command(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", destination], source, { ...process.env, npm_config_cache: join(destination, "npm-cache") }))
  assert.equal(packed.length, 1, "npm pack must produce exactly one artifact")
  const result = packed[0]
  const files = result.files.map((file: { path: string }) => file.path)
  assertPackageContents(files)
  assert.equal(result.name, "opencode-gigacode")
  return { path: join(destination, result.filename), files, size: result.size }
}

/** Installs only the production tarball and its registry dependencies. Caller owns cleanup. */
export async function preparePackedInstallation(root: string, source = resolve(dirname(fileURLToPath(import.meta.url)), ".."), artifactPath = process.env.GIGACODE_TEST_ARTIFACT) {
  root = await realpath(root)
  const artifact = artifactPath ? (await inspectPackedArtifact(resolve(artifactPath))).artifact : await packArtifact(source, join(root, "tarballs"))
  const profile = join(root, "home")
  const prefix = join(root, "prefix")
  const project = join(root, "project")
  const configurationDirectory = join(root, "config")
  for (const directory of [profile, project, configurationDirectory]) await mkdir(directory)
  const emptyNpmrc = join(root, "empty.npmrc")
  const emptyGlobalNpmrc = join(root, "empty-global.npmrc")
  await writeFile(emptyNpmrc, "\n")
  await writeFile(emptyGlobalNpmrc, "\n")
  const env: Record<string, string | undefined> = {}
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  Object.assign(env, {
    PATH: [process.platform === "win32" ? prefix : join(prefix, "bin"), dirname(process.execPath), process.env.PATH ?? process.env.Path].filter(Boolean).join(delimiter),
    HOME: profile, USERPROFILE: profile, APPDATA: join(profile, "appdata"), LOCALAPPDATA: join(profile, "localappdata"),
    XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"),
    XDG_STATE_HOME: join(profile, "state"), XDG_CACHE_HOME: join(profile, "cache"),
    OPENCODE_CONFIG_DIR: configurationDirectory, TMPDIR: root, TMP: root, TEMP: root,
    npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"),
    npm_config_userconfig: emptyNpmrc, npm_config_globalconfig: emptyGlobalNpmrc,
    npm_config_fetch_retries: "1", npm_config_fetch_retry_mintimeout: "1000", npm_config_fetch_retry_maxtimeout: "5000",
    CI: "1", NO_COLOR: "1",
  })
  await command(["npm", "install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.env.PACKAGE_CHECK_OFFLINE === "1" ? ["--offline"] : []), artifact.path], project, env)
  const packageDirectory = process.platform === "win32" ? join(prefix, "node_modules", "opencode-gigacode") : join(prefix, "lib", "node_modules", "opencode-gigacode")
  assert.equal(lstatSync(packageDirectory).isSymbolicLink(), false, "Smoke checks must use a real installed package")
  const binary = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", "gigacode.cmd"] : [join(prefix, "bin", "gigacode")]
  return { artifact, env, project, configurationDirectory, packageDirectory, binary, prefix }
}

/** Rehearses a same-version package replacement in the existing global prefix. */
export async function reinstallPackedArtifact(installation: PackedInstallation): Promise<void> {
  await command(["npm", "install", "--global", "--prefix", installation.prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.env.PACKAGE_CHECK_OFFLINE === "1" ? ["--offline"] : []), installation.artifact.path], installation.project, installation.env)
}

/** Installs and runs the distributable outside this checkout, with no dev packages. */
export async function checkPackage(source = resolve(dirname(fileURLToPath(import.meta.url)), ".."), artifactPath = process.env.GIGACODE_TEST_ARTIFACT) {
  // Match the installer's async realpath, which expands Windows 8.3 aliases.
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), "gigacode package-")))
  try {
    const installation = await preparePackedInstallation(root, source, artifactPath)
    const { artifact, env, project, configurationDirectory, packageDirectory, binary, prefix } = installation
    const installed = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"))
    assert.equal(installed.name, "opencode-gigacode")
    assert.equal(installed.license, "MIT")
    assertMITLicense(await readFile(join(packageDirectory, "LICENSE"), "utf8"))
    assert.deepEqual(installed.exports, { ".": "./index.ts", "./tui": "./tui.ts" })
    assert.equal(installed.bin.gigacode, "scripts/cli.ts")
    for (const name of ["typescript", "@types/bun", "@opencode/plugin", "@opencode/client"]) {
      assert.equal(existsSync(join(packageDirectory, "node_modules", name)), false, `Development dependency ${name} must not be installed`)
    }
    const cli = (...args: string[]) => command([...binary, ...args], project, env)
    assert.match(await cli("--help"), /gigacode setup/)
    assert.equal((await cli("--version")).trim(), `${installed.name} ${installed.version}`)
    const validated = JSON.parse(await cli("validate"))
    assert.equal(validated.valid, true)
    const rendered = JSON.parse(await cli("render", "Check the packed installation"))
    assert.ok(rendered.tasks.length > 0, "The installed CLI must render a real workflow")

    // A manifest fixture proves selected-host verification without starting a
    // native host or touching the user's OpenCode profile.
    const host = join(root, "host")
    await mkdir(join(host, "bin"), { recursive: true })
    await writeFile(join(host, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.25" }))
    const hostBinary = join(host, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
    await writeFile(hostBinary, "package check fixture; never executed\n")
    env.OPENCODE_BIN = hostBinary
    const configPath = join(configurationDirectory, "opencode.json")
    const original = { model: "fixture/model", default_agent: "plan", plugins: [{ package: "unrelated-plugin", options: { untouched: true } }], permissions: [{ action: "shell", resource: "*", effect: "ask" }], agents: { build: { model: "fixture/build" } }, experimental: { unrelatedFeature: true } }
    await writeFile(configPath, JSON.stringify(original, null, 2) + "\n")
    const optionsPath = join(root, "gigacode-options.json")
    const options = { limits: { workers: 2 } }
    await writeFile(optionsPath, JSON.stringify(options))
    const setup = JSON.parse(await cli("setup", "--global", "--config", optionsPath))
    assert.equal(await realpath(setup.packagePath), await realpath(packageDirectory))
    const configuration = JSON.parse(await readFile(configPath, "utf8"))
    for (const key of ["model", "default_agent", "permissions"] as const) assert.deepEqual(configuration[key], original[key])
    assert.deepEqual(configuration.plugins[0], original.plugins[0])
    assert.equal(await realpath(configuration.plugins[1].package), await realpath(packageDirectory))
    assert.deepEqual(configuration.plugins[1].options, options)
    assert.deepEqual(configuration.agents.build, original.agents.build)
    assert.equal(configuration.experimental.unrelatedFeature, true)
    assert.equal(configuration.agents.gigacode.mode, "primary")
    assert.equal(configuration.agents.gigacode.hidden, false)
    assert.ok(setup.backup, "Setup must back up an existing configuration")
    const before = await readFile(configPath, "utf8")
    assert.deepEqual(JSON.parse(await cli("setup", "--global")).changes, [])
    assert.equal(await readFile(configPath, "utf8"), before)

    const diagnosis = JSON.parse(await cli("doctor", "--json"))
    assert.equal(diagnosis.ok, true)
    assert.equal(diagnosis.package.name, installed.name)
    assert.equal(diagnosis.package.version, installed.version)
    assert.equal(await realpath(diagnosis.package.directory), await realpath(packageDirectory))
    assert.equal(diagnosis.host.version, "2.0.25")
    assert.equal(diagnosis.host.compatible, true)
    assert.equal(await realpath(diagnosis.profile.directory), await realpath(configurationDirectory))
    assert.equal(await realpath(diagnosis.project.directory), await realpath(project))
    const missingProfile = join(root, "missing-profile")
    const missingDiagnosis = JSON.parse(await command([...binary, "doctor", "--json", "--global-config", missingProfile], project, env, 1))
    assert.equal(missingDiagnosis.ok, false)
    assert.equal(missingDiagnosis.profile.directory, missingProfile)
    assert.ok(missingDiagnosis.checks.some((check: { status: string }) => check.status === "fail"), "A missing-profile diagnosis must identify a failed check")
    assert.equal(existsSync(missingProfile), false, "Diagnostics must not create a missing profile")

    const stateDirectory = join(project, ".gigacode")
    await mkdir(join(stateDirectory, "artifacts"), { recursive: true })
    const retained = [
      [join(project, "gigacode.json"), JSON.stringify({ limits: { attempts: 17 } })],
      [join(stateDirectory, "state.sqlite"), "saved state fixture; must remain byte-for-byte unchanged\n"],
      [join(stateDirectory, "artifacts", "saved-export.json"), "saved export fixture\n"],
      [setup.backup, await readFile(setup.backup, "utf8")],
    ] as [string, string][]
    for (const [path, contents] of retained) await writeFile(path, contents)

    // A local code change must be replaced by a real reinstall of the tarball,
    // while the durable registration and user configuration stay unchanged.
    const entrypoint = join(packageDirectory, "index.ts")
    const originalEntrypoint = await readFile(entrypoint, "utf8")
    await writeFile(entrypoint, originalEntrypoint + "\n// deliberately changed installed file\n")
    await reinstallPackedArtifact(installation)
    assert.equal(await readFile(entrypoint, "utf8"), originalEntrypoint, "Reinstall must replace the installed package contents")
    assert.equal((await cli("--version")).trim(), `${installed.name} ${installed.version}`)
    const reinstalledSetup = JSON.parse(await cli("setup", "--global"))
    assert.deepEqual(reinstalledSetup.changes, [])
    assert.equal(await realpath(reinstalledSetup.packagePath), await realpath(packageDirectory))
    assert.equal(await readFile(configPath, "utf8"), before)
    for (const [path, contents] of retained) assert.equal(await readFile(path, "utf8"), contents)

    // Rehearse the documented manual removal in this disposable profile only.
    // Keep unrelated settings and the delegation depth, which other plugins may use.
    const deregistered = JSON.parse(await readFile(configPath, "utf8"))
    deregistered.plugins = deregistered.plugins.filter((entry: { package?: string }) => entry.package !== setup.packagePath)
    for (const id of ["gigacode", "gigacode-supervisor", "gigacode-worker"]) delete deregistered.agents[id]
    await writeFile(configPath, JSON.stringify(deregistered, null, 2) + "\n")
    const afterDeregistration = await readFile(configPath, "utf8")
    await command(["npm", "uninstall", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", installed.name], project, env)
    assert.equal(existsSync(packageDirectory), false, "npm uninstall must remove the package")
    assert.equal(existsSync(process.platform === "win32" ? join(prefix, "gigacode.cmd") : join(prefix, "bin", "gigacode")), false, "npm uninstall must remove the executable shim")
    assert.equal(await readFile(configPath, "utf8"), afterDeregistration)
    assert.deepEqual(deregistered.plugins, original.plugins)
    assert.deepEqual(deregistered.agents, original.agents)
    for (const key of ["model", "default_agent", "permissions"] as const) assert.deepEqual(deregistered[key], original[key])
    assert.equal(deregistered.experimental.unrelatedFeature, true)
    for (const [path, contents] of retained) assert.equal(await readFile(path, "utf8"), contents)
    return { name: installed.name, version: installed.version, files: artifact.files.length, size: artifact.size, checks: ["npm tarball allowlist", "production npm installation", "installed CLI", "isolated global setup", "preserved settings", "idempotent setup", "installed doctor success and missing-profile refusal", "same-version package replacement", "manual deregistration and npm uninstall", "retained project files and backups"] }
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== "--artifact" || !args[1])) throw new Error("Usage: bun run scripts/check-package.ts [--artifact <tarball>]")
    console.log(JSON.stringify(await checkPackage(undefined, args[1]), null, 2))
  }
  catch (error) { console.error(error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)); process.exitCode = 1 }
}
