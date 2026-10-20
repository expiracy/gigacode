import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertMITLicense, assertPackageContents, inspectPackedArtifact, packageCommand } from "../scripts/check-package.ts"

const runtimeFiles = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "index.ts", "tui.ts", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts", "src/plugin.ts", "src/config.ts"]

test("the npm artifact rejects saved project state", () => {
  expect(() => assertPackageContents([...runtimeFiles, ".gigacode/state.sqlite"])).toThrow("Unexpected packaged file: .gigacode/state.sqlite")
})

test("the npm artifact must include both host entrypoints and the installed CLI", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "tui.ts"))).toThrow("Missing packaged file: tui.ts")
})

test("the npm artifact includes its diagnostic CLI and release notes", () => {
  expect(() => assertPackageContents(runtimeFiles)).not.toThrow()
})

test("the npm artifact accepts its reviewed product screenshots", () => {
  expect(() => assertPackageContents([...runtimeFiles, "docs/assets/workflows.png", "docs/assets/settings.png"])).not.toThrow()
})

test("unreviewed screenshots remain excluded from the npm artifact", () => {
  expect(() => assertPackageContents([...runtimeFiles, "docs/assets/provider-account.png"])).toThrow("Unexpected packaged file: docs/assets/provider-account.png")
})

test("the npm artifact must contain the installed doctor's implementation", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "scripts/doctor.ts"))).toThrow("Missing packaged file: scripts/doctor.ts")
})

test("the release artifact must include its licence", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "LICENSE"))).toThrow("Missing packaged file: LICENSE")
})

test("the packaged MIT licence accepts Windows checkout line endings", () => {
  expect(() => assertMITLicense("MIT License\r\n\r\nCopyright (c) 2026\r\n")).not.toThrow()
})

test("an unexpected licence title reports the failed package contract", () => {
  expect(() => assertMITLicense("Another licence\r\n")).toThrow("Packaged LICENSE must begin with the MIT License title")
})

test("Windows npm operations run through its command shim with whitespace paths kept as arguments", () => {
  const args = ["npm", "pack", "--pack-destination", "C:\\Release Files\\artifacts"]
  expect(packageCommand(args, "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "npm.cmd", ...args.slice(1)])
})

test("a supplied tarball is inspected before its saved state could reach npm installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigacode supplied artifact-"))
  try {
    const path = join(root, "candidate.tgz")
    const contents = Object.fromEntries(runtimeFiles.map(name => [`package/${name}`, name === "package.json" ? JSON.stringify({ name: "opencode-gigacode" }) : name === "LICENSE" ? "MIT License\n" : "fixture\n"]))
    await Bun.Archive.write(path, { ...contents, "package/.gigacode/state.sqlite": "private saved state" }, { compress: "gzip" })
    await expect(inspectPackedArtifact(path)).rejects.toThrow("Unexpected packaged file: .gigacode/state.sqlite")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a supplied tarball cannot disguise a file outside the npm package root", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigacode unsafe artifact-"))
  try {
    const path = join(root, "candidate.tgz")
    const contents = Object.fromEntries(runtimeFiles.map(name => [`package/${name}`, name === "package.json" ? JSON.stringify({ name: "opencode-gigacode" }) : name === "LICENSE" ? "MIT License\n" : "fixture\n"]))
    await Bun.Archive.write(path, { ...contents, "outside/src/extra.ts": "unexpected" }, { compress: "gzip" })
    await expect(inspectPackedArtifact(path)).rejects.toThrow("Unsafe package archive path")
  } finally { await rm(root, { recursive: true, force: true }) }
})
