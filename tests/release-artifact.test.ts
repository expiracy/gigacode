import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertCleanSource, describeReleaseArtifact, validateReleaseDocumentation, validateReleaseManifest, verifyReleaseArtifact } from "../scripts/release-artifact.ts"

const version = "0.1.0-beta.1"
const commit = "0123456789abcdef0123456789abcdef01234567"
const runtime = { bun: "1.3.14", node: "v22.0.0", npm: "11.0.0" }
const manifest = () => ({ name: "opencode-gigacode", version, license: "MIT", publishConfig: { registry: "https://registry.npmjs.org/", access: "public", tag: "next" } })
const documentation = () => new Map(Object.entries({
  "README.md": `Beta version: ${version}\nnpm install --global opencode-gigacode@next\nhttps://cdn.jsdelivr.net/npm/opencode-gigacode@${version}/LICENSE\n`,
  "CHANGELOG.md": `# Changelog\n\n## ${version} — unreleased\n`,
  "docs/installation.md": `Install opencode-gigacode@${version} or opencode-gigacode@next.\n`,
}).map(([path, text]) => [path, new File([text], path)]))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gigacode release artifact-"))
  const path = join(root, `opencode-gigacode-${version}.tgz`)
  const files: Record<string, string> = Object.fromEntries(["index.ts", "tui.ts", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts", "src/plugin.ts", "src/config.ts"].map(name => [`package/${name}`, "export {}\n"]))
  for (const [name, file] of documentation()) files[`package/${name}`] = await file.text()
  files["package/LICENSE"] = "MIT License\n"
  files["package/package.json"] = JSON.stringify(manifest())
  await Bun.Archive.write(path, files, { compress: "gzip" })
  return { root, path, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test("release preparation refuses a package marked private", () => {
  expect(() => validateReleaseManifest({ ...manifest(), private: true }, version)).toThrow("must not be private")
})

test("release preparation requires the requested candidate version", () => {
  expect(() => validateReleaseManifest({ ...manifest(), version: "0.1.0-alpha.1" }, version)).toThrow("version must be 0.1.0-beta.1")
})

test("prerelease artifacts cannot target the latest channel", () => {
  expect(() => validateReleaseManifest({ ...manifest(), publishConfig: { ...manifest().publishConfig, tag: "latest" } }, version)).toThrow("public npm registry with tag next")
})

test("release preparation rejects stale versioned guide links", async () => {
  const docs = documentation()
  docs.set("README.md", new File([(await docs.get("README.md")!.text()).replace(`@${version}/LICENSE`, "@0.1.0-alpha.1/LICENSE")], "README.md"))
  await expect(validateReleaseDocumentation(docs, version)).rejects.toThrow("README.md refers to a different package version")
})

test("release metadata binds the actual tarball bytes to a source commit", async () => {
  const value = await fixture()
  try {
    const metadata = await describeReleaseArtifact(value.path, version, commit, runtime)
    expect(metadata).toMatchObject({ schemaVersion: 1, name: "opencode-gigacode", version, tag: "next", commit, runtime, filename: `opencode-gigacode-${version}.tgz`, fileCount: 12 })
    expect(metadata.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
    expect(metadata.shasum).toMatch(/^[a-f0-9]{40}$/)
    expect(metadata.size).toBeGreaterThan(0)
  } finally { await value.cleanup() }
})

test("later artifact verification rejects even a one-byte tarball change", async () => {
  const value = await fixture()
  try {
    const metadata = await describeReleaseArtifact(value.path, version, commit, runtime)
    await writeFile(join(value.root, "release.json"), JSON.stringify(metadata))
    const changed = await readFile(value.path)
    changed[0] = changed[0]! ^ 1
    await writeFile(value.path, changed)
    await expect(verifyReleaseArtifact(value.root, version, commit)).rejects.toThrow("Release artifact integrity mismatch")
  } finally { await value.cleanup() }
})

test("later verification requires the explicitly selected source commit", async () => {
  const value = await fixture()
  try {
    const metadata = await describeReleaseArtifact(value.path, version, commit, runtime)
    await writeFile(join(value.root, "release.json"), JSON.stringify(metadata))
    await expect(verifyReleaseArtifact(value.root, version, "f".repeat(40))).rejects.toThrow("Release source commit mismatch")
  } finally { await value.cleanup() }
})

test("preparation cannot label uncommitted source changes with the previous commit", () => {
  expect(() => assertCleanSource(" M package.json\n?? src/new-feature.ts\n")).toThrow("clean committed source checkout")
})

test("verification accepts an unchanged artifact without rewriting it", async () => {
  const value = await fixture()
  try {
    const metadata = await describeReleaseArtifact(value.path, version, commit, runtime)
    const source = JSON.stringify(metadata)
    await writeFile(join(value.root, "release.json"), source)
    const before = await readFile(value.path)
    expect(await verifyReleaseArtifact(value.root, version, commit)).toEqual(metadata)
    expect(await readFile(value.path)).toEqual(before)
    expect(await readFile(join(value.root, "release.json"), "utf8")).toBe(source)
  } finally { await value.cleanup() }
})

test("artifact metadata must record the Bun, Node and npm versions", async () => {
  const value = await fixture()
  try {
    await expect(describeReleaseArtifact(value.path, version, commit, {} as typeof runtime)).rejects.toThrow("Release runtime metadata must contain Bun, Node and npm version numbers only")
  } finally { await value.cleanup() }
})
