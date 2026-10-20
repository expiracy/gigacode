import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPublishContext, preparePublishCandidate, publishArtifact, readPublicVersion, resolveVersionTag, runNpmPublish, sanitizeDiagnostic } from "../scripts/publish-artifact.mjs";

const commit = "a".repeat(40);
const candidate = {
  name: "opencode-gigacode", version: "0.1.0-beta.2", commit,
  filename: "opencode-gigacode-0.1.0-beta.2.tgz", integrity: "sha512-tested", tag: "next",
};
const context = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "expiracy/gigacode",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_SHA: commit,
  GITHUB_WORKFLOW_REF: "expiracy/gigacode/.github/workflows/publish.yml@refs/heads/main",
  RUNNER_ENVIRONMENT: "github-hosted", GIGACODE_PUBLISH_ACTION: "publish", GIGACODE_PUBLISH_ENVIRONMENT: "npm-production",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/example",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-oidc-request-token",
};

test("rehearsal reports the tested candidate without contacting npm or publishing", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  assert.deepEqual(await publishArtifact({ mode: "rehearsal", candidate, lookup: unexpected, publish: unexpected }), {
    outcome: "rehearsal", name: candidate.name, version: candidate.version, integrity: candidate.integrity, tag: "next",
  });
});

test("publish refuses unprotected source before any registry operation", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: { ...context, GITHUB_REF_PROTECTED: "false" }, lookup: unexpected, publish: unexpected }), /protected main/);
});

test("a published identical version is reported without publishing or moving npm tags", async () => {
  const calls = [];
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, version) => { calls.push([name, version]); return { name, version: candidate.version, dist: { integrity: candidate.integrity } }; },
    publish: () => { throw new Error("An existing version must not be published again"); },
  });
  assert.equal(result.outcome, "already-published");
  assert.deepEqual(calls, [[candidate.name, candidate.version], [candidate.name, "next"]]);
});

test("an absent version publishes once and succeeds only after public integrity matches", async () => {
  const calls = [];
  let reads = 0;
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => ++reads === 1 ? undefined : { name: candidate.name, version: candidate.version, dist: { integrity: candidate.integrity } },
    publish: async value => { calls.push(value); },
  });
  assert.equal(result.outcome, "published");
  assert.deepEqual(calls, [candidate]);
  assert.equal(reads, 3);
});

test("publication requires its immutable version tag at the exact tested commit", async () => {
  const unexpected = () => { throw new Error("Unexpected registry operation"); };
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context,
    resolveTag: () => "b".repeat(40), lookup: unexpected, publish: unexpected,
  }), /version tag.*tested commit/);
});

test("registry lookup treats only a structured npm 404 as an absent version", async () => {
  const calls = [];
  const result = await readPublicVersion(candidate.name, candidate.version, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ error: "version not found: 0.1.0-beta.2" }), { status: 404, headers: { "content-type": "application/json" } });
  });
  assert.equal(result, undefined);
  assert.equal(calls[0].url, "https://registry.npmjs.org/opencode-gigacode/0.1.0-beta.2");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, "error");
});

test("registry lookup accepts npm's actual exact-version missing response", async () => {
  assert.equal(await readPublicVersion(candidate.name, candidate.version, async () => new Response(JSON.stringify(`version not found: ${candidate.version}`), {
    status: 404, headers: { "content-type": "application/json" },
  })), undefined);
});

test("npm receives an isolated copy of the tested bytes with OIDC and provenance and no inherited credentials", async () => {
  const bytes = Buffer.from("the exact tested npm tarball bytes");
  let copiedPath;
  await runNpmPublish({ ...candidate, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }, {
    env: { ...context, PATH: process.env.PATH, NODE_AUTH_TOKEN: "do-not-inherit", NPM_CONFIG_REGISTRY: "https://wrong.example", npm_config_provenance: "false" },
    run: async (file, args, options) => {
      assert.equal(file, "npm");
      copiedPath = args[1];
      assert.deepEqual(await readFile(copiedPath), bytes);
      assert.equal(args[0], "publish");
      for (const flag of ["--ignore-scripts", "--provenance", "--access", "public", "--tag", "next", "--registry", "https://registry.npmjs.org/"]) assert.ok(args.includes(flag));
      assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
      assert.equal(options.env.npm_config_provenance, undefined);
      assert.equal(options.env.NPM_CONFIG_REGISTRY, undefined);
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, context.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
      assert.equal(await readFile(options.env.NPM_CONFIG_USERCONFIG, "utf8"), "");
      assert.equal(await readFile(options.env.NPM_CONFIG_GLOBALCONFIG, "utf8"), "");
      assert.ok(options.env.NPM_CONFIG_CACHE.startsWith(options.cwd));
    },
  });
  await assert.rejects(readFile(copiedPath), /ENOENT/);
});

test("artifact verification refuses a candidate whose version differs from checked source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gigacode-publish-version-"));
  const sourceDirectory = path.join(directory, "source");
  const artifact = path.join(directory, "artifact");
  try {
    await mkdir(sourceDirectory);
    await mkdir(artifact);
    await writeFile(path.join(sourceDirectory, "package.json"), JSON.stringify({ name: candidate.name, version: "0.1.0-beta.3" }));
    await writeFile(path.join(artifact, "release.json"), JSON.stringify(candidate));
    const git = args => execFileSync("git", args, { cwd: sourceDirectory, encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["add", "."]);
    git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    await assert.rejects(preparePublishCandidate({ directory: artifact, sourceDirectory, commit: git(["rev-parse", "HEAD"]).trim() }), /checked source version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "gigacode-publish-artifact-"));
  const sourceDirectory = path.join(directory, "source");
  const artifacts = path.join(directory, "artifact");
  await mkdir(path.join(sourceDirectory, "scripts"), { recursive: true });
  await mkdir(path.join(artifacts, "package/docs"), { recursive: true });
  await mkdir(path.join(artifacts, "package/src"));
  await mkdir(path.join(artifacts, "package/scripts"));
  const manifest = { name: candidate.name, version: candidate.version, license: "MIT", publishConfig: { registry: "https://registry.npmjs.org/", access: "public", tag: "next" } };
  await writeFile(path.join(sourceDirectory, "package.json"), JSON.stringify(manifest));
  for (const name of ["release-artifact.ts", "check-package.ts", "publish-artifact.mjs"]) await writeFile(path.join(sourceDirectory, "scripts", name), await readFile(new URL(`../scripts/${name}`, import.meta.url)));
  const git = args => execFileSync("git", args, { cwd: sourceDirectory, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const fixtureCommit = git(["rev-parse", "HEAD"]).trim();
  const files = { "package.json": JSON.stringify(manifest), "LICENSE": "MIT License\n",
    "README.md": `opencode-gigacode@next ${candidate.version}\n`, "docs/installation.md": `opencode-gigacode@next ${candidate.version}\n`, "CHANGELOG.md": `# Changes\n\n## ${candidate.version}\n\nTested releases.\n`,
    "index.ts": "export {};\n", "tui.ts": "export {};\n", "scripts/cli.ts": "export {};\n", "scripts/install.ts": "export {};\n", "scripts/doctor.ts": "export {};\n", "src/plugin.ts": "export {};\n", "src/config.ts": "export {};\n" };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(artifacts, "package", name), contents);
  execFileSync("tar", ["-czf", path.join(artifacts, candidate.filename), "-C", artifacts, "package"]);
  const bytes = await readFile(path.join(artifacts, candidate.filename));
  const metadata = { ...candidate, schemaVersion: 1, commit: fixtureCommit, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex"), size: bytes.length, fileCount: Object.keys(files).length, runtime: { bun: "1.3.14", node: process.version, npm: "12.2.0" } };
  await writeFile(path.join(artifacts, "release.json"), JSON.stringify(metadata));
  return { directory, sourceDirectory, artifacts, commit: fixtureCommit, bytes, metadata, git, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("the real CLI rehearses the verified artifact and retains a review receipt without npm credentials", async () => {
  const f = await fixture();
  try {
    const diagnostics = path.join(f.directory, "diagnostics");
    execFileSync(process.execPath, [path.join(f.sourceDirectory, "scripts/publish-artifact.mjs"), "rehearsal", "--directory", f.artifacts, "--commit", f.commit, "--diagnostics", diagnostics], { cwd: f.sourceDirectory, env: { PATH: process.env.PATH }, encoding: "utf8" });
    const record = JSON.parse(await readFile(path.join(diagnostics, "result.json"), "utf8"));
    assert.equal(record.outcome, "rehearsal");
    assert.equal(record.commit, f.commit);
    assert.equal(record.integrity, f.metadata.integrity);
    assert.equal(record.versionTag, `v${candidate.version}`);
    assert.deepEqual(await readFile(path.join(f.artifacts, candidate.filename)), f.bytes);
  } finally { await f.cleanup(); }
});

test("publication context refuses alternate workflows, forks, triggers, runners and legacy credentials", () => {
  for (const change of [
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_REPOSITORY: "example/gigacode" }, { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_WORKFLOW_REF: "expiracy/gigacode/.github/workflows/release.yml@refs/heads/main" },
    { RUNNER_ENVIRONMENT: "self-hosted" }, { GIGACODE_PUBLISH_ACTION: "rehearsal" }, { GIGACODE_PUBLISH_ENVIRONMENT: "npm" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.githubusercontent.com.attacker.example/token" },
    { NODE_AUTH_TOKEN: "legacy" }, { NPM_TOKEN: "legacy" }, { npm_config__authToken: "legacy" }, { NPM_CONFIG_USERCONFIG: "/unsafe/npmrc" },
  ]) assert.throws(() => assertPublishContext({ ...context, ...change }));
});

test("registry auth, server, arbitrary 404, non-JSON and transport failures fail closed", async () => {
  for (const [status, body, contentType] of [
    [401, { error: "Unauthorized" }, "application/json"], [500, { error: "Internal Server Error" }, "application/json"],
    [404, { error: "unrelated" }, "application/json"], [404, "version not found: a-different-version", "application/json"],
    [404, "<h1>Not found</h1>", "text/html"], [200, { name: candidate.name, version: candidate.version }, "application/json"],
  ]) await assert.rejects(readPublicVersion(candidate.name, candidate.version, async () => new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } })));
  await assert.rejects(readPublicVersion(candidate.name, candidate.version, async () => { throw new Error("Network unavailable"); }), /Network unavailable/);
});

test("conflicting public bytes cannot publish, overwrite or change tags", async () => {
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => ({ name: candidate.name, version: candidate.version, dist: { integrity: "sha512-different" } }),
    publish: () => assert.fail("Conflicting versions must stay immutable"),
  }), /different bytes/);
});

test("a moved next channel fails without promoting an older existing version", async () => {
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, selector) => ({ name, version: selector === "next" ? "0.1.0-beta.3" : candidate.version, dist: { integrity: candidate.integrity } }),
    publish: () => assert.fail("An existing version must not move tags"),
  }), /next channel points elsewhere; no npm tags were changed/);
});

test("failed registry verification after a publish does not replay the write", async () => {
  let reads = 0;
  let writes = 0;
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => { if (++reads === 1) return undefined; throw new Error("Registry temporarily unavailable"); },
    publish: async () => { writes++; },
  }), /Registry temporarily unavailable/);
  assert.equal(writes, 1);
});

test("a changed in-memory archive is rejected before npm starts", async () => {
  await assert.rejects(runNpmPublish({ ...candidate, bytes: Buffer.from("changed") }, {
    run: () => assert.fail("Changed bytes must not reach npm"),
  }), /archive changed/);
});

test("the tag resolver refuses a missing tag and resolves an annotated version tag to its commit", async () => {
  const f = await fixture();
  try {
    assert.throws(() => resolveVersionTag(candidate, f.sourceDirectory), /Create the immutable version tag/);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", `v${candidate.version}`, "-m", "candidate"]);
    assert.equal(resolveVersionTag(candidate, f.sourceDirectory), f.commit);
  } finally { await f.cleanup(); }
});

test("retained diagnostics remove opaque OIDC credentials and common npm tokens", () => {
  const message = sanitizeDiagnostic(`failure ${context.ACTIONS_ID_TOKEN_REQUEST_TOKEN} npm_exampleSecretToken Bearer example-token`, context);
  assert.equal(message, "failure [redacted] [redacted] [redacted]");
});
