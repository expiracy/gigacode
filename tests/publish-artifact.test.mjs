import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPublishContext, preparePublishCandidate, publishArtifact, readPublicPublication, readPublicVersion, resolveVersionTag, runNpmPublish, sanitizeDiagnostic } from "../scripts/publish-artifact.mjs";

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
const snapshot = (version, channel = version) => ({ version, channel });

test("rehearsal reports the tested candidate without contacting npm or publishing", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  assert.deepEqual(await publishArtifact({ mode: "rehearsal", candidate, lookup: unexpected, publish: unexpected }), {
    outcome: "rehearsal", name: candidate.name, version: candidate.version, integrity: candidate.integrity, tag: "next", packagedTag: "next",
  });
});

test("explicit latest rehearsal reports the chosen channel without changing the packaged channel", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  const result = await publishArtifact({ mode: "rehearsal", channel: "latest", candidate, lookup: unexpected, publish: unexpected });
  assert.equal(result.tag, "latest");
  assert.equal(result.packagedTag, "next");
  assert.equal(candidate.tag, "next");
});

test("publish refuses unprotected source before any registry operation", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: { ...context, GITHUB_REF_PROTECTED: "false" }, lookup: unexpected, publish: unexpected }), /protected main/);
});

test("a published identical version is reported without publishing or moving npm tags", async () => {
  const calls = [];
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, version, channel) => { calls.push([name, version, channel]); return snapshot({ name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } }); },
    publish: () => { throw new Error("An existing version must not be published again"); },
  });
  assert.equal(result.outcome, "already-published");
  assert.deepEqual(calls, [[candidate.name, candidate.version, "next"]]);
});

test("an absent version publishes once and succeeds only after public integrity matches", async () => {
  const calls = [];
  let reads = 0;
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => ++reads === 1 ? snapshot() : snapshot({ name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } }),
    publish: async value => { calls.push(value); },
  });
  assert.equal(result.outcome, "published");
  assert.deepEqual(calls, [candidate]);
  assert.equal(reads, 2);
});

test("a new beta explicitly publishes to latest and verifies latest while preserving candidate metadata", async () => {
  const reads = [];
  const writes = [];
  const result = await publishArtifact({ mode: "publish", channel: "latest", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, version, channel) => {
      reads.push([version, channel]);
      return reads.length === 1 ? snapshot() : snapshot({ name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } });
    },
    publish: async (value, options) => writes.push({ value, options }),
  });
  assert.deepEqual(reads, [[candidate.version, "latest"], [candidate.version, "latest"]]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, candidate);
  assert.deepEqual(writes[0].options, { tag: "latest" });
  assert.equal(candidate.tag, "next");
  assert.equal(result.tag, "latest");
  assert.equal(result.packagedTag, "next");
});

test("publication requires its immutable version tag at the exact tested commit", async () => {
  const unexpected = () => { throw new Error("Unexpected registry operation"); };
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context,
    resolveTag: () => "b".repeat(40), lookup: unexpected, publish: unexpected,
  }), /version tag.*tested commit/);
});

test("registry lookup reads a missing version from the canonical package index without negative endpoint caching", async () => {
  const calls = [];
  const result = await readPublicVersion(candidate.name, candidate.version, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ name: candidate.name, versions: {}, "dist-tags": {} }), { headers: { "content-type": "application/json" } });
  });
  assert.equal(result, undefined);
  assert.equal(calls[0].url, "https://registry.npmjs.org/opencode-gigacode");
  assert.equal(calls[0].options.headers["cache-control"], "no-cache");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, "error");
});

test("a valid canonical package index can have no chosen channel yet", async () => {
  assert.equal(await readPublicVersion(candidate.name, "next", async () => new Response(JSON.stringify({ name: candidate.name, versions: {}, "dist-tags": {} }), {
    headers: { "content-type": "application/json" },
  })), undefined);
});

test("registry lookup verifies the latest selector using its returned package version", async () => {
  const data = { name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } };
  const found = await readPublicVersion(candidate.name, "latest", async url => {
    assert.equal(url, `https://registry.npmjs.org/${candidate.name}`);
    return new Response(JSON.stringify({ name: candidate.name, versions: { [candidate.version]: data }, "dist-tags": { latest: candidate.version } }), { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(found, data);
});

test("registry lookup accepts an exact stable release version", async () => {
  const data = { name: candidate.name, version: "0.1.0", license: "MIT", dist: { integrity: candidate.integrity } };
  assert.deepEqual(await readPublicVersion(candidate.name, "0.1.0", async url => {
    assert.equal(url, `https://registry.npmjs.org/${candidate.name}`);
    return new Response(JSON.stringify({ name: candidate.name, versions: { "0.1.0": data }, "dist-tags": { latest: "0.1.0" } }), { headers: { "content-type": "application/json" } });
  }), data);
});

test("one canonical index snapshot supplies both exact version and selected channel", async () => {
  const current = { name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } };
  const older = { ...current, version: "0.1.0-beta.1", dist: { integrity: "sha512-older" } };
  let requests = 0;
  const result = await readPublicPublication(candidate.name, candidate.version, "next", async (url, options) => {
    requests++;
    assert.equal(url, `https://registry.npmjs.org/${candidate.name}`);
    assert.equal(options.headers["cache-control"], "no-cache");
    return new Response(JSON.stringify({ name: candidate.name, versions: { [current.version]: current, [older.version]: older }, "dist-tags": { next: older.version } }), {
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(result, { version: current, channel: older });
  assert.equal(requests, 1);
});

test("stable publication follows its packaged latest tag and verifies the exact stable version", async () => {
  const value = { ...candidate, version: "0.1.0", tag: "latest" };
  const selectors = [];
  let writes = 0;
  const result = await publishArtifact({ mode: "publish", candidate: value, env: context, resolveTag: () => commit,
    lookup: async (name, version, channel) => {
      selectors.push([version, channel]);
      return selectors.length === 1 ? snapshot() : snapshot({ name, version: value.version, license: "MIT", dist: { integrity: value.integrity } });
    },
    publish: async (artifact, options) => {
      writes++;
      assert.equal(artifact, value);
      assert.deepEqual(options, { tag: "latest" });
    },
  });
  assert.equal(result.outcome, "published");
  assert.equal(result.tag, "latest");
  assert.equal(result.packagedTag, "latest");
  assert.deepEqual(selectors, [["0.1.0", "latest"], ["0.1.0", "latest"]]);
  assert.equal(writes, 1);
});

test("invalid exact versions are rejected before a registry request", async () => {
  for (const version of ["v0.1.0", "01.1.0", "0.1.0+build", "0.1.0-rc.1", "0.1.0-beta.01", "0.1.0/path"]) {
    await assert.rejects(readPublicVersion(candidate.name, version, () => assert.fail("Invalid versions must not reach npm")), /Expected a stable version/);
  }
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

test("npm receives the explicit latest tag with the exact original tarball", async () => {
  const bytes = Buffer.from("a beta artifact packaged with tag next");
  const value = { ...candidate, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  await runNpmPublish(value, { tag: "latest", env: context, run: async (file, args) => {
    assert.equal(file, "npm");
    assert.equal(args[args.indexOf("--tag") + 1], "latest");
    assert.deepEqual(await readFile(args[1]), bytes);
  } });
  assert.equal(value.tag, "next");
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

test("the real CLI records latest for approval without changing its next-tagged tested archive", async () => {
  const f = await fixture();
  try {
    const diagnostics = path.join(f.directory, "diagnostics");
    const summary = path.join(f.directory, "summary.md");
    execFileSync(process.execPath, [path.join(f.sourceDirectory, "scripts/publish-artifact.mjs"), "rehearsal", "--channel", "latest", "--directory", f.artifacts, "--commit", f.commit, "--diagnostics", diagnostics], {
      cwd: f.sourceDirectory, env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8",
    });
    const record = JSON.parse(await readFile(path.join(diagnostics, "result.json"), "utf8"));
    assert.equal(record.tag, "latest");
    assert.equal(record.packagedTag, "next");
    assert.equal(record.integrity, f.metadata.integrity);
    assert.match(await readFile(summary, "utf8"), /Publication channel: `latest`/);
    assert.match(await readFile(summary, "utf8"), /Packaged channel: `next`/);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.artifacts, "release.json"), "utf8")), f.metadata);
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
    lookup: async () => snapshot({ name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: "sha512-different" } }),
    publish: () => assert.fail("Conflicting versions must stay immutable"),
  }), /different bytes/);
});

test("a moved next channel fails without promoting an older existing version", async () => {
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async name => snapshot(
      { name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } },
      { name, version: "0.1.0-beta.3", license: "MIT", dist: { integrity: "sha512-newer" } },
    ),
    publish: () => assert.fail("An existing version must not move tags"),
  }), /next channel points elsewhere; no npm tags were changed/);
});

test("latest cannot promote an existing version whose latest tag points elsewhere", async () => {
  const reads = [];
  await assert.rejects(publishArtifact({ mode: "publish", channel: "latest", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, version, channel) => {
      reads.push([version, channel]);
      return snapshot(
        { name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } },
        { name, version: "0.1.0-beta.1", license: "MIT", dist: { integrity: "sha512-older" } },
      );
    },
    publish: () => assert.fail("Existing versions must not be published or retagged"),
  }), /latest channel points elsewhere; no npm tags were changed/);
  assert.deepEqual(reads, [[candidate.version, "latest"]]);
});

test("a matching latest rerun succeeds without another publication", async () => {
  const result = await publishArtifact({ mode: "publish", channel: "latest", candidate, env: context, resolveTag: () => commit,
    lookup: async name => snapshot({ name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } }),
    publish: () => assert.fail("A matching rerun must not publish"),
  });
  assert.equal(result.outcome, "already-published");
  assert.equal(result.tag, "latest");
  assert.equal(result.packagedTag, "next");
});

test("unsupported channel choices fail before any external operation", async () => {
  const unexpected = () => { throw new Error("Unexpected external operation"); };
  for (const channel of ["", "next", "Latest", "latest --access restricted"]) {
    await assert.rejects(publishArtifact({ mode: "publish", channel, candidate, env: context,
      resolveTag: unexpected, lookup: unexpected, publish: unexpected,
    }), /Choose package or latest publication channel/);
    if (channel !== "next") await assert.rejects(runNpmPublish(candidate, { tag: channel, run: unexpected }), /Choose next or latest npm publication tag/);
  }
});

test("a latest publish fails if public bytes appear only on next", async () => {
  let writes = 0;
  let reads = 0;
  await assert.rejects(publishArtifact({ mode: "publish", channel: "latest", candidate, env: context, resolveTag: () => commit,
    lookup: async name => {
      if (++reads === 1) return snapshot();
      return snapshot(
        { name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } },
        { name, version: "0.1.0-beta.1", license: "MIT", dist: { integrity: "sha512-older" } },
      );
    },
    publish: async () => { writes++; },
    wait: async () => {},
  }), /did not verify on the latest channel/);
  assert.equal(writes, 1);
  assert.equal(reads, 7);
});

test("the CLI rejects invalid channel input before reading any artifact", () => {
  assert.throws(() => execFileSync(process.execPath, [new URL("../scripts/publish-artifact.mjs", import.meta.url).pathname,
    "rehearsal", "--channel", "untrusted", "--directory", "/missing/artifact", "--commit", commit, "--diagnostics", "/missing/diagnostics",
  ], { env: { PATH: process.env.PATH }, encoding: "utf8", stdio: "pipe" }), error => {
    assert.match(error.stderr, /Choose package or latest publication channel/);
    assert.doesNotMatch(error.stderr, /ENOENT/);
    return true;
  });
});

test("failed registry verification after a publish does not replay the write", async () => {
  let reads = 0;
  let writes = 0;
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => { if (++reads === 1) return snapshot(); throw new Error("Registry temporarily unavailable"); },
    publish: async () => { writes++; },
    wait: () => assert.fail("Network errors must fail immediately"),
  }), /Registry temporarily unavailable/);
  assert.equal(writes, 1);
});

test("a successful publish waits for a temporarily missing public version without replaying npm", async () => {
  const selectors = [];
  const waits = [];
  let writes = 0;
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async (name, version, channel) => {
      selectors.push([version, channel]);
      return selectors.length <= 2 ? snapshot() : snapshot({ name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } });
    },
    publish: async () => { writes++; },
    wait: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result.outcome, "published");
  assert.deepEqual(selectors, [[candidate.version, "next"], [candidate.version, "next"], [candidate.version, "next"]]);
  assert.equal(waits.length, 1);
  assert.equal(writes, 1);
});

test("a conflicting public licence after publishing fails immediately without another npm write", async () => {
  let reads = 0;
  let writes = 0;
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async name => ++reads === 1 ? snapshot() : snapshot({ name, version: candidate.version, license: "GPL-3.0", dist: { integrity: candidate.integrity } }),
    publish: async () => { writes++; },
    wait: () => assert.fail("Conflicting licences must not be retried"),
  }), /different bytes or invalid metadata/);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("post-publish verification retries stale and absent chosen channels with bounded read-only waits", async () => {
  const selectors = [];
  const waits = [];
  let writes = 0;
  const record = { name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } };
  const result = await publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async (_name, version, channel) => {
      selectors.push([version, channel]);
      if (selectors.length === 1) return snapshot();
      if (selectors.length === 2) return snapshot(record, { ...record, version: "0.1.0-beta.1", dist: { integrity: "sha512-older" } });
      return selectors.length === 3 ? { version: record, channel: undefined } : snapshot(record);
    },
    publish: async () => { writes++; },
    wait: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result.outcome, "published");
  assert.equal(writes, 1);
  assert.deepEqual(waits, [5_000, 15_000]);
  assert.deepEqual(selectors, Array.from({ length: 4 }, () => [candidate.version, "next"]));
});

test("missing post-publish visibility stops after six checks without repeating npm", async () => {
  let reads = 0;
  let writes = 0;
  const waits = [];
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    lookup: async () => { reads++; return snapshot(); },
    publish: async () => { writes++; },
    wait: async milliseconds => { waits.push(milliseconds); },
  }), /after six public visibility checks.*Publication was not retried/);
  assert.equal(reads, 7);
  assert.equal(writes, 1);
  assert.deepEqual(waits, [5_000, 15_000, 40_000, 80_000, 160_000]);
  assert.equal(waits.reduce((sum, milliseconds) => sum + milliseconds, 0), 300_000);
});

test("the real default reader makes one canonical request per bounded post-publish check", async context_ => {
  const requests = [];
  const waits = [];
  let writes = 0;
  context_.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ name: candidate.name, versions: {}, "dist-tags": {} }), {
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
    publish: async () => { writes++; }, wait: async milliseconds => { waits.push(milliseconds); },
  }), /after six public visibility checks/);
  assert.equal(requests.length, 7, "One preflight request and six post-write visibility requests");
  for (const request of requests) {
    assert.equal(request.url, `https://registry.npmjs.org/${candidate.name}`);
    assert.equal(request.options.headers["cache-control"], "no-cache");
  }
  assert.deepEqual(waits, [5_000, 15_000, 40_000, 80_000, 160_000]);
  assert.equal(writes, 1);
});

test("conflicting exact public metadata after a successful write never enters the visibility retry", async () => {
  const valid = { name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } };
  for (const change of [{ name: "unexpected" }, { version: "0.1.0-beta.1" }, { license: "GPL-3.0" }, { dist: { integrity: "sha512-different" } }]) {
    let reads = 0;
    let writes = 0;
    await assert.rejects(publishArtifact({ mode: "publish", candidate, env: context, resolveTag: () => commit,
      lookup: async () => ++reads === 1 ? snapshot() : snapshot({ ...valid, ...change }),
      publish: async () => { writes++; },
      wait: () => assert.fail("A conflict must fail immediately"),
    }), /different bytes or invalid metadata/);
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  }
});

test("canonical package metadata rejects conflicts and missing-package errors instead of treating them as propagation", async () => {
  const valid = { name: candidate.name, version: candidate.version, license: "MIT", dist: { integrity: candidate.integrity } };
  for (const change of [{ name: "unexpected" }, { version: "0.1.0-beta.1" }, { license: "GPL-3.0" }, { dist: {} }]) {
    await assert.rejects(readPublicVersion(candidate.name, candidate.version, async () => new Response(JSON.stringify({
      name: candidate.name, versions: { [candidate.version]: { ...valid, ...change } }, "dist-tags": {},
    }), { headers: { "content-type": "application/json" } })), /invalid version metadata/);
  }
  await assert.rejects(readPublicVersion(candidate.name, candidate.version, async () => new Response(JSON.stringify({ error: "Not found" }), {
    status: 404, headers: { "content-type": "application/json" },
  })), /HTTP 404/);
});

test("malformed package maps and channel targets cannot masquerade as a missing public version", async () => {
  for (const body of [
    { name: "unexpected", versions: {}, "dist-tags": {} },
    { name: candidate.name, versions: [], "dist-tags": {} },
    { name: candidate.name, versions: {}, "dist-tags": [] },
    { name: candidate.name, versions: {}, "dist-tags": { latest: "https://unexpected.example" } },
  ]) await assert.rejects(readPublicVersion(candidate.name, "latest", async () => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })), /invalid package index|invalid channel version/);
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
