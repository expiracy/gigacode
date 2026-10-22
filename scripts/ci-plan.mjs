import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const documentation = /^(?:README\.md|CHANGELOG\.md|LICENSE(?:\.md)?|\.github\/FUNDING\.yml|docs\/.+\.(?:md|png|svg|jpe?g|gif|webp))$/;
const compatibilityFiles = new Set([
  "package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "bunfig.toml", ".bun-version", ".node-version", ".nvmrc", ".npmrc",
  "scripts/ci-plan.mjs", "scripts/check-package.ts", "scripts/publish-artifact.mjs", "scripts/github-release.mjs",
  "index.ts", "tui.ts", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts",
  "tests/opencode.integration.ts", "tests/parallel.integration.ts", "tests/workflow-fixture.ts", "spike/host.ts",
]);

export function createCiPlan({ eventName, paths = [], full = true, artifactRetentionDays = eventName === "workflow_call" ? 30 : 1 }) {
  assert.ok(["pull_request", "push", "workflow_dispatch", "workflow_call"].includes(eventName), "Unsupported CI event.");
  assert.equal(typeof full, "boolean", "The full CI input must be Boolean.");
  assert.ok(Array.isArray(paths) && paths.every(path => typeof path === "string" && path && !path.includes("\0") && !path.startsWith("/")
    && path.split("/").every(part => part && part !== "." && part !== "..")), "Supply valid changed repository paths.");
  assert.ok(Number.isInteger(artifactRetentionDays) && artifactRetentionDays >= 1 && artifactRetentionDays <= 30, "Artifact retention must be 1–30 whole days.");
  const requested = ["workflow_dispatch", "workflow_call"].includes(eventName);
  const compatibility = paths.some(path => compatibilityFiles.has(path) || path.startsWith(".github/workflows/")
    || /^scripts\/release-artifact\.[^/]+$/.test(path) || /^tsconfig[^/]*\.json$/.test(path));
  let profile = "fast";
  if (requested) profile = full ? "full" : "fast";
  else if (compatibility) profile = "full";
  else if (paths.length > 0 && paths.every(path => documentation.test(path))) profile = "docs";
  return { profile, artifactRetentionDays, diagnosticRetentionDays: Math.min(artifactRetentionDays, 7) };
}

export function assertCiGate(plan, results) {
  assert.ok(plan && typeof plan === "object" && ["docs", "fast", "full"].includes(plan.profile), "Missing or invalid CI plan.");
  assert.deepEqual(Object.keys(plan).sort(), ["artifactRetentionDays", "diagnosticRetentionDays", "profile"], "Incomplete CI plan outputs.");
  assert.ok(Number.isInteger(plan.artifactRetentionDays) && plan.artifactRetentionDays >= 1 && plan.artifactRetentionDays <= 30
    && plan.diagnosticRetentionDays === Math.min(plan.artifactRetentionDays, 7), "Invalid CI retention outputs.");
  const jobs = ["plan", "checks", "artifact", "package", "native", "parallel"];
  assert.ok(results && typeof results === "object", "Missing CI job results.");
  assert.deepEqual(Object.keys(results).sort(), [...jobs].sort(), "Incomplete CI job results.");
  for (const job of jobs) {
    const required = job === "plan" || job === "checks" && plan.profile !== "docs" || !["plan", "checks"].includes(job) && plan.profile === "full";
    assert.equal(results[job], required ? "success" : "skipped", `Unexpected ${job} result for ${plan.profile} CI.`);
  }
  return true;
}
async function changedPaths(eventName, eventPath) {
  if (!["pull_request", "push"].includes(eventName)) return [];
  assert.ok(eventPath, "Automatic CI requires its event payload.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  const head = eventName === "pull_request" ? event.pull_request?.head?.sha : event.after;
  assert.ok(/^[a-f0-9]{40}$/.test(base ?? "") && /^[a-f0-9]{40}$/.test(head ?? "") && head !== "0".repeat(40), "Changed-file comparison requires full commit SHAs.");
  const args = eventName === "push" && base === "0".repeat(40)
    ? ["ls-files", "-z"]
    : ["diff", "--name-only", "--no-renames", "-z", ...(eventName === "pull_request" ? [`${base}...${head}`] : [base, head])];
  const names = execFileSync("git", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8_000_000 });
  assert.ok(!names || names.endsWith("\0"), "Incomplete changed-file comparison.");
  return names ? names.slice(0, -1).split("\0") : [];
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, "Choose CI plan or gate.");
    if (process.argv[2] === "plan") {
      const full = process.env.CI_FULL ?? "";
      assert.ok(["", "true", "false"].includes(full), "The full CI input must be Boolean.");
      const retention = process.env.CI_ARTIFACT_RETENTION_DAYS;
      // Only workflow_call declares this input; a reusable workflow otherwise
      // inherits its caller's event name, including pull_request and push.
      const eventName = retention ? "workflow_call" : process.env.GITHUB_EVENT_NAME;
      const plan = createCiPlan({
        eventName, paths: await changedPaths(eventName, process.env.GITHUB_EVENT_PATH),
        full: full === "" || full === "true",
        artifactRetentionDays: retention ? Number(retention) : eventName === "workflow_call" ? 30 : 1,
      });
      const serialized = JSON.stringify(plan);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
        `profile=${plan.profile}\nartifact-retention-days=${plan.artifactRetentionDays}\ndiagnostic-retention-days=${plan.diagnosticRetentionDays}\nplan=${serialized}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `### CI profile: ${plan.profile}\n\nAutomatic docs use the light gate; ordinary code uses Ubuntu checks; dependency, runtime and delivery changes use the full matrix. Manual and release inputs select the requested profile.\n\n- Package retention: ${plan.artifactRetentionDays} days\n- Full-run diagnostics: ${plan.diagnosticRetentionDays} days\n`);
      console.log(serialized);
    } else if (process.argv[2] === "gate") {
      const needs = JSON.parse(process.env.CI_NEEDS ?? "");
      assert.ok(needs && typeof needs === "object" && !Array.isArray(needs), "Missing CI dependency results.");
      const results = Object.fromEntries(Object.entries(needs).map(([job, value]) => [job, value?.result]));
      assertCiGate(JSON.parse(process.env.CI_PLAN ?? ""), results);
      console.log("CI passed with every planned job successful and only intentional skips.");
    } else throw new Error("Choose CI plan or gate.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

