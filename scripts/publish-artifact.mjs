import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function preparePublishCandidate({ directory, commit, sourceDirectory = root }) {
  assert.match(commit, /^[a-f0-9]{40}$/, "Supply the full source commit.");
  const source = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory, encoding: "utf8", timeout: 30_000 }).trim(), commit, "The checked source commit differs.");
  const record = JSON.parse(await readFile(path.join(directory, "release.json"), "utf8"));
  assert.equal(record.version, source.version, "The artifact must match the checked source version.");
  assert.equal(record.name, source.name, "The artifact must match the checked source package.");
  // Reuse the existing archive, licence, runtime and documentation verifier;
  // its subprocess receives no npm credentials or GitHub OIDC request token.
  const metadata = JSON.parse(execFileSync("bun", ["run", path.join(sourceDirectory, "scripts/release-artifact.ts"), "verify", directory, source.version, commit], {
    cwd: sourceDirectory, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000,
  }));
  const bytes = await readFile(path.join(directory, metadata.filename));
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, metadata.integrity, "The artifact changed after verification.");
  return { ...metadata, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function runNpmPublish(candidate, { tag = candidate.tag, env = process.env, run = promisify(execFile) } = {}) {
  assert.ok(["next", "latest"].includes(tag), "Choose next or latest npm publication tag.");
  assert.equal(`sha512-${createHash("sha512").update(candidate.bytes).digest("base64")}`, candidate.integrity, "The tested archive changed before publication.");
  const work = await mkdtemp(path.join(tmpdir(), "gigacode-npm-publish-"));
  await chmod(work, 0o700);
  try {
    const archive = path.join(work, "candidate.tgz");
    const userConfig = path.join(work, "user.npmrc");
    const globalConfig = path.join(work, "global.npmrc");
    await writeFile(archive, candidate.bytes, { mode: 0o600, flag: "wx" });
    await writeFile(userConfig, "", { mode: 0o600, flag: "wx" });
    await writeFile(globalConfig, "", { mode: 0o600, flag: "wx" });
    const npmEnv = {};
    for (const key of ["PATH", "GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REPOSITORY_OWNER_ID", "GITHUB_REF", "GITHUB_SHA", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_JOB", "GITHUB_WORKSPACE", "RUNNER_ENVIRONMENT", "RUNNER_OS", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"]) {
      if (env[key]) npmEnv[key] = env[key];
    }
    Object.assign(npmEnv, { TMPDIR: work, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: path.join(work, "cache"), NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false" });
    await run("npm", ["publish", archive, "--tag", tag, "--access", "public", "--ignore-scripts", "--provenance", "--json", "--registry", "https://registry.npmjs.org/"], {
      cwd: work, env: npmEnv, encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000,
    });
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function resolveVersionTag(candidate, sourceDirectory = root) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `refs/tags/v${candidate.version}^{commit}`], {
      cwd: sourceDirectory, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { throw new Error(`Create the immutable version tag v${candidate.version} with the GitHub release workflow before publishing.`); }
}

export async function readPublicVersion(name, version, request = fetch) {
  assert.equal(name, "opencode-gigacode", "Unexpected npm package.");
  const channel = ["next", "latest"].includes(version);
  assert.ok(channel || /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)\.(?:0|[1-9]\d*))?$/.test(version), "Expected a stable version, numbered alpha/beta prerelease or the next/latest channel.");
  const response = await request(`https://registry.npmjs.org/${name}/${version}`, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.headers.get("content-type")?.includes("application/json"), "npm returned a non-JSON response.");
  const data = await response.json();
  if (response.status === 404 && (data === `version not found: ${version}` || data?.error === `version not found: ${version}` || data?.error === "Not found")) return undefined;
  assert.equal(response.status, 200, `npm registry lookup failed (HTTP ${response.status}).`);
  assert.ok(data?.name === name && (channel || data.version === version) && typeof data.dist?.integrity === "string", "npm returned invalid version metadata.");
  return data;
}

export function assertPublishContext(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "npm publication requires GitHub Actions.");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "npm publication requires a manual request.");
  assert.equal(env.GITHUB_REPOSITORY, "expiracy/gigacode", "npm publication requires the upstream repository.");
  assert.ok(env.GITHUB_REF === "refs/heads/main" && env.GITHUB_REF_PROTECTED === "true", "npm publication requires protected main.");
  assert.equal(env.GITHUB_WORKFLOW_REF, "expiracy/gigacode/.github/workflows/publish.yml@refs/heads/main", "npm publication requires publish.yml on main.");
  assert.equal(env.GIGACODE_PUBLISH_ACTION, "publish", "npm publication must be explicitly requested.");
  assert.equal(env.GIGACODE_PUBLISH_ENVIRONMENT, "npm-production", "npm publication requires the npm-production environment.");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "npm publication requires a GitHub-hosted runner.");
  const tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "https://invalid.example");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && tokenUrl.protocol === "https:" && tokenUrl.hostname.endsWith(".actions.githubusercontent.com") && !tokenUrl.username && !tokenUrl.password, "npm publication requires GitHub Actions OIDC.");
  assert.ok(!Object.entries(env).some(([key, value]) => value && (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$/i.test(key) || /^(?:npm_config_.*(?:auth|token)|npm_config_userconfig|npm_config_globalconfig)$/i.test(key))), "Legacy npm credentials or configuration are forbidden.");
}

function assertPublishedBytes(record, candidate) {
  assert.ok(record?.name === candidate.name && record.version === candidate.version && record.dist?.integrity === candidate.integrity,
    "The npm version contains different bytes or invalid metadata; prepare a new version.");
}

export function publicationTag(candidate, channel = "package") {
  assert.ok(["package", "latest"].includes(channel), "Choose package or latest publication channel.");
  assert.ok(["next", "latest"].includes(candidate.tag), "Unexpected packaged publication channel.");
  return channel === "latest" ? "latest" : candidate.tag;
}

export async function publishArtifact({ mode, channel = "package", candidate, env = process.env, lookup, publish, resolveTag = resolveVersionTag }) {
  const tag = publicationTag(candidate, channel);
  if (mode === "rehearsal") return {
    outcome: "rehearsal", name: candidate.name, version: candidate.version, integrity: candidate.integrity, tag, packagedTag: candidate.tag,
  };
  assert.equal(mode, "publish", "Choose rehearsal or publish delivery.");
  assertPublishContext(env);
  assert.equal(candidate.commit, env.GITHUB_SHA, "The tested artifact must match the workflow commit.");
  assert.equal(await resolveTag(candidate), candidate.commit, "The immutable version tag must identify the tested commit.");
  const existing = await lookup(candidate.name, candidate.version);
  if (existing) {
    assertPublishedBytes(existing, candidate);
    const publicChannel = await lookup(candidate.name, tag);
    assert.ok(publicChannel?.version === candidate.version && publicChannel.dist?.integrity === candidate.integrity, `The ${tag} channel points elsewhere; no npm tags were changed.`);
    return { outcome: "already-published", name: candidate.name, version: candidate.version, integrity: candidate.integrity, tag, packagedTag: candidate.tag };
  }
  await publish(candidate, { tag });
  assertPublishedBytes(await lookup(candidate.name, candidate.version), candidate);
  const publicChannel = await lookup(candidate.name, tag);
  assert.ok(publicChannel?.version === candidate.version && publicChannel.dist?.integrity === candidate.integrity, `Publication did not verify on the ${tag} channel; review npm before rerunning.`);
  return { outcome: "published", name: candidate.name, version: candidate.version, integrity: candidate.integrity, tag, packagedTag: candidate.tag };
}

export function sanitizeDiagnostic(value, env = process.env) {
  let text = String(value ?? "");
  for (const [key, secret] of Object.entries(env)) if (secret && /(?:TOKEN|PASSWORD|AUTH)/i.test(key)) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/npm_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(?:Bearer\s+)[^\s,]+/gi, "[redacted]")
    .replace(/([?&](?:token|sessionId|auth|key)=)[^&\s]+/gi, "$1[redacted]").slice(-32_000);
}

function argumentsFor(argv) {
  const [mode, ...flags] = argv;
  assert.ok(["rehearsal", "publish"].includes(mode), "Choose rehearsal or publish delivery.");
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]?.replace(/^--/, "");
    assert.ok(flags[index]?.startsWith("--") && ["directory", "commit", "diagnostics", "channel"].includes(key) && flags[index + 1] && !flags[index + 1].startsWith("--") && !Object.hasOwn(options, key), "Invalid npm publish arguments.");
    options[key] = flags[index + 1];
  }
  assert.ok(options.directory && options.commit && options.diagnostics, "Supply --directory, --commit and --diagnostics.");
  assert.ok(options.channel === undefined || ["package", "latest"].includes(options.channel), "Choose package or latest publication channel.");
  return { mode, options };
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  let options;
  let result = { outcome: "failure" };
  try {
    const parsed = argumentsFor(process.argv.slice(2));
    options = parsed.options;
    if (parsed.mode === "publish") assertPublishContext();
    const candidate = await preparePublishCandidate(options);
    const delivered = await publishArtifact({ mode: parsed.mode, channel: options.channel, candidate, lookup: readPublicVersion, publish: runNpmPublish });
    result = { ...delivered, commit: candidate.commit, sha256: candidate.sha256, versionTag: `v${candidate.version}` };
    const message = parsed.mode === "rehearsal"
      ? "Rehearsal passed. No npm publication was requested. Create the version tag, then explicitly request publication and approve the npm-production environment."
      : `${candidate.name}@${candidate.version}: ${delivered.outcome}; public bytes and ${delivered.tag} channel verified.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `### npm delivery: ${delivered.outcome}\n\n${message}\n\n- Package: \`${candidate.name}@${candidate.version}\`\n- Source: \`${candidate.commit}\`\n- Version tag: \`v${candidate.version}\`\n- Publication channel: \`${delivered.tag}\`\n- Packaged channel: \`${candidate.tag}\`\n- SHA-256: \`${candidate.sha256}\`\n- Integrity: \`${candidate.integrity}\`\n`, { flag: "a" });
  } catch (error) {
    result.failure = sanitizeDiagnostic(error.message);
    console.error(result.failure);
    process.exitCode = 1;
  } finally {
    if (options?.diagnostics) {
      await mkdir(options.diagnostics, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.diagnostics, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    }
  }
}
