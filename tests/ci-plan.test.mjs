import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertCiGate, createCiPlan } from "../scripts/ci-plan.mjs";

const script = fileURLToPath(new URL("../scripts/ci-plan.mjs", import.meta.url));

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "gigacode-ci-plan-"));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => {
    git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "--quiet"]);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "README.md"), "Initial documentation\n");
  await writeFile(path.join(root, "src/plugin.ts"), "export {};\n");
  git(["add", "README.md", "src/plugin.ts"]);
  const base = commit();
  return { root, git, commit, base, clean: () => rm(root, { recursive: true, force: true }) };
}

test("documentation-only pull requests run the light gate without retaining artifacts", () => {
  assert.deepEqual(createCiPlan({ eventName: "pull_request", paths: ["README.md", "docs/installation.md", "docs/assets/logo.svg"] }), {
    profile: "docs", artifactRetentionDays: 1, diagnosticRetentionDays: 1,
  });
});

test("ordinary source or unknown paths require Ubuntu checks without the full matrix", () => {
  assert.equal(createCiPlan({ eventName: "pull_request", paths: ["src/plugin.ts", "unrecognised.config"] }).profile, "fast");
});

test("dependency changes automatically exercise the full release compatibility matrix", () => {
  assert.equal(createCiPlan({ eventName: "push", paths: ["bun.lock"] }).profile, "full");
});

test("the public plugin entrypoint requires installed host coverage", () => {
  assert.equal(createCiPlan({ eventName: "pull_request", paths: ["index.ts"] }).profile, "full");
});

test("an explicit manual full run overrides documentation-only classification and retains one day", () => {
  assert.deepEqual(createCiPlan({ eventName: "workflow_dispatch", full: true, paths: ["README.md"] }), {
    profile: "full", artifactRetentionDays: 1, diagnosticRetentionDays: 1,
  });
});

test("reusable release calls retain their tested package for thirty days", () => {
  assert.deepEqual(createCiPlan({ eventName: "workflow_call", full: true, artifactRetentionDays: 30 }), {
    profile: "full", artifactRetentionDays: 30, diagnosticRetentionDays: 7,
  });
});

test("unknown event contexts fail before they can skip checks", () => {
  assert.throws(() => createCiPlan({ eventName: "pull_request_target", paths: ["README.md"] }), /Unsupported CI event/);
});

test("the aggregate accepts only the intentionally skipped jobs of a docs plan", () => {
  assert.equal(assertCiGate(createCiPlan({ eventName: "pull_request", paths: ["README.md"] }), {
    plan: "success", checks: "skipped", artifact: "skipped", package: "skipped", native: "skipped", parallel: "skipped",
  }), true);
});

test("ordinary source, empty diffs and unknown extensions keep the conservative fast policy", () => {
  for (const paths of [[], ["tests/engine.test.ts"], ["docs/example.ts"], ["README.md", "src/plugin.ts"], [".github/unknown.yml"]]) {
    assert.equal(createCiPlan({ eventName: "pull_request", paths }).profile, "fast");
  }
  assert.equal(createCiPlan({ eventName: "workflow_dispatch", full: false, paths: ["package.json"] }).profile, "fast");
});

test("delivery, dependency and runtime policy paths select the full automatic profile", () => {
  for (const path of ["package.json", "bun.lock", "package-lock.json", ".bun-version", ".github/workflows/publish.yml", "scripts/ci-plan.mjs", "scripts/release-artifact.ts", "scripts/check-package.ts", "scripts/publish-artifact.mjs", "scripts/github-release.mjs", "index.ts", "tui.ts", "tsconfig.json", "tsconfig.build.json", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts", "tests/opencode.integration.ts", "tests/parallel.integration.ts", "tests/workflow-fixture.ts", "spike/host.ts"]) {
    assert.equal(createCiPlan({ eventName: "pull_request", paths: ["README.md", path] }).profile, "full", path);
  }
});

test("malformed planning inputs cannot produce a cheap passing route", () => {
  for (const change of [{ full: "false" }, { paths: ["../README.md"] }, { paths: [""] }, { paths: [null] }, { artifactRetentionDays: 0 }, { artifactRetentionDays: 31 }, { artifactRetentionDays: 1.5 }]) {
    assert.throws(() => createCiPlan({ eventName: "pull_request", paths: ["README.md"], ...change }));
  }
});

test("the aggregate requires the fast job and every full-matrix job when planned", () => {
  const fast = createCiPlan({ eventName: "pull_request", paths: ["src/plugin.ts"] });
  const fastResults = { plan: "success", checks: "success", artifact: "skipped", package: "skipped", native: "skipped", parallel: "skipped" };
  assert.equal(assertCiGate(fast, fastResults), true);
  for (const checks of ["failure", "cancelled", "skipped", ""]) assert.throws(() => assertCiGate(fast, { ...fastResults, checks }));
  const full = createCiPlan({ eventName: "workflow_call", full: true });
  const fullResults = Object.fromEntries(Object.keys(fastResults).map(job => [job, "success"]));
  assert.equal(assertCiGate(full, fullResults), true);
  for (const job of Object.keys(fullResults)) for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.throws(() => assertCiGate(full, { ...fullResults, [job]: result }), `${job}: ${result}`);
  }
});

test("the aggregate rejects missing outputs, unplanned work and cancellation even for docs", () => {
  const plan = createCiPlan({ eventName: "pull_request", paths: ["README.md"] });
  const results = { plan: "success", checks: "skipped", artifact: "skipped", package: "skipped", native: "skipped", parallel: "skipped" };
  for (const badPlan of [undefined, {}, { ...plan, profile: "" }, { ...plan, artifactRetentionDays: "1" }, { ...plan, diagnosticRetentionDays: undefined }]) {
    assert.throws(() => assertCiGate(badPlan, results));
  }
  for (const badResults of [{ ...results, plan: "cancelled" }, { ...results, plan: "failure" }, { ...results, checks: "success" }, { ...results, artifact: "cancelled" }, {}, { ...results, unexpected: "success" }]) {
    assert.throws(() => assertCiGate(plan, badResults));
  }
});

test("the real planner compares a pull request's commits and writes reusable job outputs", async () => {
  const f = await repository();
  try {
    await writeFile(path.join(f.root, "README.md"), "Updated documentation\n");
    f.git(["add", "README.md"]);
    const head = f.commit();
    const event = path.join(f.root, "event.json");
    const output = path.join(f.root, "output");
    await writeFile(event, JSON.stringify({ pull_request: { base: { sha: f.base }, head: { sha: head }, draft: true } }));
    const stdout = execFileSync(process.execPath, [script, "plan"], { cwd: f.root, env: {
      PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
    }, encoding: "utf8" });
    assert.match(stdout, /"profile":"docs"/);
    const outputs = await readFile(output, "utf8");
    assert.match(outputs, /^profile=docs$/m);
    assert.match(outputs, /^artifact-retention-days=1$/m);
    assert.match(outputs, /^plan=\{"profile":"docs"/m);
  } finally { await f.clean(); }
});

test("real Git renames retain the deleted source path on pushes and draft pull requests", async () => {
  const f = await repository();
  try {
    f.git(["mv", "src/plugin.ts", "docs/plugin.md"]);
    const head = f.commit();
    const event = path.join(f.root, "event.json");
    for (const [eventName, payload] of [
      ["push", { before: f.base, after: head }],
      ["pull_request", { pull_request: { base: { sha: f.base }, head: { sha: head }, draft: true } }],
      ["pull_request", { pull_request: { base: { sha: f.base }, head: { sha: head }, draft: false } }],
    ]) {
      await writeFile(event, JSON.stringify(payload));
      const result = JSON.parse(execFileSync(process.execPath, [script, "plan"], { cwd: f.root, env: {
        PATH: process.env.PATH, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event,
      }, encoding: "utf8" }));
      assert.equal(result.profile, "fast");
    }
  } finally { await f.clean(); }
});

test("standalone manual CI and reusable release calls keep their separate retention inputs", () => {
  for (const [retention, expected] of [[undefined, 1], ["30", 30]]) {
    const env = { PATH: process.env.PATH, GITHUB_EVENT_NAME: "workflow_dispatch", CI_FULL: "true" };
    if (retention) env.CI_ARTIFACT_RETENTION_DAYS = retention;
    const plan = JSON.parse(execFileSync(process.execPath, [script, "plan"], { env, encoding: "utf8" }));
    assert.equal(plan.profile, "full");
    assert.equal(plan.artifactRetentionDays, expected);
  }
  const fast = JSON.parse(execFileSync(process.execPath, [script, "plan"], { env: {
    PATH: process.env.PATH, GITHUB_EVENT_NAME: "workflow_dispatch", CI_FULL: "false",
  }, encoding: "utf8" }));
  assert.equal(fast.profile, "fast");
});

test("a reusable call retains its full profile even when the caller event is a pull request", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [script, "plan"], { env: {
    PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request", CI_FULL: "true", CI_ARTIFACT_RETENTION_DAYS: "30",
  }, encoding: "utf8", stdio: "pipe" }));
  assert.deepEqual(plan, { profile: "full", artifactRetentionDays: 30, diagnosticRetentionDays: 7 });
});

test("the real aggregate fails for cancelled work or empty planner outputs", () => {
  const plan = createCiPlan({ eventName: "pull_request", paths: ["src/plugin.ts"] });
  const needs = Object.fromEntries(Object.entries({ plan: "success", checks: "success", artifact: "skipped", package: "skipped", native: "skipped", parallel: "skipped" }).map(([job, result]) => [job, { result }]));
  const env = { PATH: process.env.PATH, CI_PLAN: JSON.stringify(plan), CI_NEEDS: JSON.stringify(needs) };
  assert.match(execFileSync(process.execPath, [script, "gate"], { env, encoding: "utf8" }), /CI passed/);
  for (const change of [{ CI_PLAN: "" }, { CI_NEEDS: JSON.stringify({ ...needs, checks: { result: "cancelled" } }) }]) {
    assert.throws(() => execFileSync(process.execPath, [script, "gate"], { env: { ...env, ...change }, encoding: "utf8", stdio: "pipe" }));
  }
});
