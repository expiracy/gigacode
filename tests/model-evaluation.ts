import type { Limits, ModelRef, Run } from "../src/types.ts"
import { modelRef, modelReference, parseConfig, roles, stages, strictRecord } from "../src/config.ts"
import type { Manifest } from "../src/workspace.ts"
import { changedPaths, manifest } from "../src/workspace.ts"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { assertHostVersion } from "../src/compatibility.ts"
import { UltraRpc } from "../src/rpc.ts"
import { sanitizeEventData } from "../src/store.ts"

export function evaluationUsage(sessions: EvaluationSession[]): { cost: number | null; knownCost: number; tokens: number | null; unknownCostSessions: string[] } {
  const unique = [...new Map(sessions.map(session => [session.id, session])).values()]
  const known = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
  const unknownCostSessions = unique.filter(session => !known(session.cost)).map(session => session.id)
  const knownCost = unique.reduce((total, session) => total + (known(session.cost) ? session.cost : 0), 0)
  let tokenTotal = 0, tokensKnown = true
  for (const session of unique) {
    const tokens = session.tokens
    const counts = tokens && [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write]
    if (!counts?.every(known)) tokensKnown = false
    else tokenTotal += counts.reduce((sum, count) => sum + count, 0)
  }
  return { cost: unknownCostSessions.length ? null : knownCost, knownCost, tokens: tokensKnown ? tokenTotal : null, unknownCostSessions }
}

export const evaluationScenarios = ["bugfix", "feature", "research", "planning", "interrupted"] as const
export type EvaluationScenario = typeof evaluationScenarios[number]
export interface EvaluationOptions { url: string; model: ModelRef; modelReference: string; limits: Limits; maxCost: number; scenarios: EvaluationScenario[] }
export interface EvaluationSession { id: string; parentID?: string; model?: ModelRef; outcome?: "succeeded" | "failed" | "interrupted"; cost?: number; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
export interface EvaluationEvidence { run: Run; before: Manifest; after: Manifest; sessions: EvaluationSession[]; oracle?: { passed: boolean; output: string }; interrupted?: { supervisorId: string; acceptedAttemptIds: string[]; successorTaskId: string; nativeOutcome: string } }
export interface EvaluationScore { checks: { name: string; passed: boolean; detail: string }[]; quality: { criterion: string; status: "needs-review"; expected: string }[]; passed: boolean }
export function scoreEvaluation(scenario: EvaluationScenario, evidence: EvaluationEvidence, model: ModelRef): EvaluationScore {
  const { run, after } = evidence
  const accepted = run.tasks.flatMap(task => {
    const attempt = task.attempts.find(item => item.id === task.acceptedAttemptId)
    return task.status === "succeeded" && attempt?.status === "succeeded" ? [{ task, attempt }] : []
  })
  const historicalIds = new Set(run.repairRound > 0 ? run.plans?.at(-2)?.tasks.map(task => task.id) : [])
  const requiredIds = new Set(run.phase === "planning"
    ? run.tasks.map(task => task.spec.id)
    : (run.plans?.at(-1)?.tasks ?? run.tasks.map(task => task.spec)).filter(task => !historicalIds.has(task.id)).map(task => task.id))
  const currentAccepted = accepted.filter(({ task }) => requiredIds.has(task.spec.id))
  const graphComplete = requiredIds.size > 0 && [...requiredIds].every(id => currentAccepted.some(({ task }) => task.spec.id === id))
  const checks: EvaluationScore["checks"] = []
  checks.push({ name: "runtime outcome", passed: run.status === (scenario === "bugfix" || scenario === "feature" ? "succeeded" : "ready") && !run.tasks.some(task => task.attempts.some(attempt => ["reserved", "running", "waiting_permission", "cancelling", "ambiguous"].includes(attempt.status))), detail: `Recorded runtime outcome: ${run.status}; incomplete or unsettled work remains explicit.` })
  const allowed = scenario === "bugfix" ? ["src/parse.ts", "tests/parse.test.ts"] : scenario === "feature" ? ["src/chunk.ts", "tests/chunk.test.ts"] : []
  const changed = changedPaths(evidence.before, after)
  checks.push({ name: "scope preservation", passed: changed.every(path => allowed.includes(path)), detail: `Changed paths: ${changed.join(", ") || "none"}; allowed: ${allowed.join(", ") || "read-only"}.` })
  if (["research", "planning", "interrupted"].includes(scenario)) {
    checks.push({ name: "planning scope", passed: run.mode === "plan" && run.phase === "planning" && run.status === "ready" && run.tasks.every(task => !task.spec.writes && task.spec.role !== "implementer" && task.spec.stage !== "verification" && task.attempts.every(attempt => !attempt.checks.length)), detail: "Read-only work must stop ready without admitting implementation or executing configured checks." })
  }
  if (scenario === "interrupted") {
    const interrupted = evidence.interrupted
    const successor = interrupted && run.tasks.find(task => task.spec.id === interrupted.successorTaskId)
    const followsPreservedWork = successor?.spec.dependencies.some(id => accepted.some(({ task, attempt }) => task.spec.id === id && interrupted?.acceptedAttemptIds.includes(attempt.id)))
    checks.push({ name: "interruption recovery", passed: !!interrupted && interrupted.acceptedAttemptIds.length > 0 && !!followsPreservedWork && interrupted.nativeOutcome === "interrupted" && [run.supervisorSessionId, ...(run.supervisorHistory ?? [])].includes(interrupted.supervisorId) && interrupted.acceptedAttemptIds.every(id => accepted.some(({ attempt }) => attempt.id === id)) && run.tasks.every(task => task.attempts.filter(attempt => attempt.status === "succeeded").length <= 1), detail: "Native interruption must be recorded while a successor follows completed predecessor work, that saved work retained, and already successful tasks never repeated." })
  }
  const sessions = new Map(evidence.sessions.map(session => [session.id, session]))
  const sameModel = (value: ModelRef | undefined) => value?.providerID === model.providerID && value.id === model.id && (value.variant === "default" && model.variant === undefined ? undefined : value.variant) === model.variant
  const supervisor = run.supervisorSessionId && sessions.get(run.supervisorSessionId)
  const sessionProof = !!supervisor && supervisor.parentID === run.parentSessionId && sameModel(supervisor.model) && sameModel(sessions.get(run.parentSessionId)?.model) && graphComplete && accepted.every(({ attempt }) => {
    const session = attempt.sessionId && sessions.get(attempt.sessionId)
    return !!session && [run.supervisorSessionId, ...(run.supervisorHistory ?? [])].includes(session.parentID) && session.outcome === "succeeded" && sameModel(session.model) && sameModel(attempt.model.ref)
  })
  checks.push({ name: "native sessions", passed: sessionProof, detail: "Every accepted worker must have a succeeded native child outcome, selected model, and recorded supervisor ancestry." })
  if (scenario === "bugfix" || scenario === "feature") {
    checks.push({ name: "fixture behavior", passed: evidence.oracle?.passed === true, detail: evidence.oracle?.output ?? "Independent fixture assertions were not executed." })
    const writers = currentAccepted.filter(({ task }) => task.spec.writes)
    const followsWriters = (task: Run["tasks"][number]) => {
      const ancestors = new Set<string>(), pending = [...task.spec.dependencies]
      while (pending.length) {
        const id = pending.pop()!
        if (ancestors.has(id)) continue
        ancestors.add(id); pending.push(...(run.tasks.find(task => task.spec.id === id)?.spec.dependencies ?? []))
      }
      return writers.every(({ task }) => ancestors.has(task.spec.id))
    }
    checks.push({ name: "independent review", passed: writers.length > 0 && currentAccepted.some(({ task, attempt }) => task.spec.role === "reviewer" && task.spec.stage === "review" && attempt.workspaceHash === after.hash && followsWriters(task)), detail: "A succeeded independent reviewer must inspect the final candidate after every current writer." })
    const verified = run.config.checks.length > 0 && run.config.checks.every(configured => {
      const latest = currentAccepted.flatMap(({ task, attempt }) => task.spec.role === "verifier" && task.spec.stage === "verification" && task.spec.checkIds?.includes(configured.id) && attempt.workspaceHash === after.hash && followsWriters(task) ? attempt.checks.filter(check =>
        writers.every(({ attempt }) => attempt.finishedAt !== undefined && check.startedAt >= attempt.finishedAt) && check.finishedAt >= check.startedAt && check.checkId === configured.id && check.command === configured.command && check.taskId === task.spec.id && check.attemptId === attempt.id && check.sessionId === attempt.sessionId && !!check.callId && check.cwd === run.directory && check.workspaceHash === after.hash && JSON.stringify(check.criterionIds.toSorted()) === JSON.stringify(configured.criterionIds.toSorted()),
      ) : []).toSorted((a, b) => a.finishedAt - b.finishedAt).at(-1)
      return latest?.outcome === "passed" && latest.exit === 0
    })
    checks.push({ name: "native verification", passed: verified, detail: "Assigned verifiers must capture every configured check against the final candidate with matching native identities; model claims are not proof." })
  }
  const quality: EvaluationScore["quality"] = [
    { criterion: "requirement understanding", status: "needs-review", expected: "The accepted result preserves the user request, constraints and public contracts." },
    { criterion: "reasoning and evidence", status: "needs-review", expected: "Root causes, design choices and conclusions are supported by concrete inspected code or versioned primary sources; contradictions remain explicit." },
    { criterion: "agent use", status: "needs-review", expected: "Each worker has a useful distinct purpose, dependencies pass relevant evidence, and extra workers justify their cost." },
    { criterion: "honest outcome", status: "needs-review", expected: "The final response accurately describes actual checks, unresolved findings, partial outcomes and unexecuted work." },
    { criterion: "fixture conclusions", status: "needs-review", expected: {
      bugfix: "Zero is valid; malformed input and values exceeding the safe-integer boundary are rejected without rounding; existing duration units remain compatible.",
      feature: "The original identity export remains compatible; chunk preserves order and input, retains a short final group, and rejects invalid group sizes.",
      research: "The v2 contract specifies 2500 ms, no automatic timeout retry, and caller retry only with an idempotency key; exact v2 documents outweigh the conflicting v1 example.",
      planning: "The proposal identifies minute-conversion overflow and grammar boundaries, scoped source/tests changes, independent review, configured native verification and unresolved decisions without implementing them.",
      interrupted: "The report explains the interruption and retained evidence honestly, with successful predecessor work reused rather than repeated.",
    }[scenario] },
  ]
  return { checks, quality, passed: checks.every(check => check.passed) }
}
export function parseEvaluationOptions(args: string[]): EvaluationOptions {
  const fields: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!
    if (!["--url", "--model", "--budget", "--max-cost", "--scenario"].includes(name)) throw new Error(`Unknown evaluation option: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith("--") || fields[name] !== undefined) throw new Error(`Supply ${name} exactly once with a value`)
    fields[name] = value
  }
  for (const name of ["--url", "--model", "--budget", "--max-cost"]) if (!fields[name]) throw new Error(`Evaluation requires explicit ${name}`)
  const url = new URL(fields["--url"]!)
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Evaluation URL must be an explicit loopback OpenCode endpoint without credentials or a path")
  const selected = modelReference(fields["--model"]!)
  if (selected === "inherit") throw new Error("Evaluation requires an explicit connected provider/model")
  const supplied = strictRecord(JSON.parse(fields["--budget"]!), Object.keys(parseConfig({}).limits), "evaluation budget")
  for (const name of ["attempts", "steps", "workerMs", "runMs"]) if (supplied[name] === undefined) throw new Error(`Evaluation budget requires ${name}`)
  const limits = parseConfig({ limits: supplied }).limits
  const maxCost = Number(fields["--max-cost"])
  if (!Number.isFinite(maxCost) || maxCost <= 0) throw new Error("--max-cost must be a positive finite observed USD allowance")
  const scenario = fields["--scenario"] as EvaluationScenario | undefined
  if (scenario !== undefined && !evaluationScenarios.includes(scenario)) throw new Error(`Unknown evaluation scenario: ${scenario}`)
  return { url: url.origin, model: modelRef(selected), modelReference: selected, limits, maxCost, scenarios: scenario ? [scenario] : [...evaluationScenarios] }
}

export async function prepareEvaluationFixture(scenario: EvaluationScenario, directory: string, options: EvaluationOptions): Promise<string> {
  const files: Record<string, string> = {
    "protected.txt": "Preserve this sentinel exactly.\n",
    "package.json": JSON.stringify({ private: true, type: "module", scripts: { test: "bun test tests" } }),
    "ultracode.json": JSON.stringify({
      models: { default: options.modelReference, roles: Object.fromEntries(roles.map(role => [role, options.modelReference])), stages: Object.fromEntries(stages.map(stage => [stage, options.modelReference])) },
      limits: options.limits, parallelWrites: false,
      checks: scenario !== "research" ? [{ id: "fixture-tests", command: "bun run test", criterionIds: ["verification"] }] : [],
    }),
    "src/parse.ts": 'export function parseDuration(value: string): number {\n  const match = /^(\\d+)(ms|s)$/.exec(value)\n  if (!match) throw new Error("Invalid duration")\n  const result = Number(match[1]) * (match[2] === "s" ? 1000 : 1)\n  if (!result) throw new Error("Invalid duration")\n  return result\n}\n',
    "tests/parse.test.ts": 'import { expect, test } from "bun:test"\nimport { parseDuration } from "../src/parse.ts"\ntest("existing seconds behavior", () => expect(parseDuration("2s")).toBe(2000))\n',
  }
  if (scenario === "feature") {
    delete files["src/parse.ts"]; delete files["tests/parse.test.ts"]
    files["src/chunk.ts"] = "export function identity<T>(values: T[]): T[] { return values }\n"
    files["tests/chunk.test.ts"] = 'import { expect, test } from "bun:test"\nimport { identity } from "../src/chunk.ts"\ntest("existing identity behavior", () => { const values = [1, 2]; expect(identity(values)).toBe(values) })\n'
  }
  if (scenario === "research") {
    delete files["src/parse.ts"]; delete files["tests/parse.test.ts"]
    files["docs/v1-contract.md"] = "# Fixture API v1 contract\nA timeout retries automatically once. Default timeout: 1000 ms.\n"
    files["docs/v2-contract.md"] = "# Fixture API v2 contract\nA timeout does not retry automatically. Default timeout: 2500 ms. A caller may retry only requests carrying an idempotency key.\n"
    files["docs/v2-release.md"] = "# Fixture API v2 migration\nVersion 2 removes the automatic retry from version 1 and changes the default timeout. A v1-only example is not evidence for v2.\n"
  }
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true }); await writeFile(join(directory, name), content)
  }
  if (scenario === "research") return "Use the cross-checked-research recipe to establish the retry and default-timeout contract for a client pinned to fixture API v2. Inspect the versioned primary documents under docs, reconcile the conflicting v1 statement, cite exact paths and versions, and explain which requests may be retried. Stop at a read-only report; do not implement or run commands."
  if (scenario === "interrupted") return "Evaluate recovery while planning a minimal extension to parseDuration that accepts minutes and preserves the existing API. Use two sequential read-only workers in one plan workflow: an explorer task named inspect examines the source, callers, tests and precision boundaries; a planner task named design depends on inspect and uses its accepted evidence to compare alternatives and propose scoped implementation, independent review and configured native verification. Preserve the first worker's accepted evidence through interruption; do not repeat successful investigation. Stop at a read-only proposal; do not modify files or execute checks."
  if (scenario === "planning") return "Plan a minimal extension to parseDuration that accepts minutes while preserving the existing API. Inspect the source, callers and tests, identify boundary and precision risks, compare the smallest alternatives, and propose scoped implementation, independent review and native verification. Stop at a read-only proposal; do not modify any files or execute checks."
  return scenario === "feature"
    ? "Add exported generic chunk(values, size) to the existing API. Preserve identity. Return consecutive groups preserving order without modifying values; empty input returns [], and a final short group is retained. Reject non-positive, fractional and unsafe sizes. Modify only src/chunk.ts and tests/chunk.test.ts. Add relevant tests, run configured checks and complete independent review."
    : "Fix parseDuration and add regression tests. Preserve existing milliseconds/seconds behavior; accept zero; reject malformed, signed, decimal or whitespace inputs and values beyond Number.MAX_SAFE_INTEGER without rounding. Modify only src/parse.ts and tests/parse.test.ts. Run the configured checks and complete independent review."
}

export async function checkEvaluationFixture(scenario: "bugfix" | "feature", directory: string): Promise<{ passed: boolean; output: string }> {
  const module = pathToFileURL(join(directory, scenario === "bugfix" ? "src/parse.ts" : "src/chunk.ts")).href
  const assertions = scenario === "feature" ? `const { chunk, identity } = await import(${JSON.stringify(module)})
const values = [1, 2, 3, 4, 5]; assert.equal(identity(values), values)
assert.deepEqual(chunk(values, 2), [[1, 2], [3, 4], [5]])
assert.deepEqual(chunk(values, 1), [[1], [2], [3], [4], [5]])
assert.deepEqual(chunk(values, 10), [[1, 2, 3, 4, 5]])
assert.deepEqual(chunk([], 2), []); assert.deepEqual(chunk(["a", "b", "c"], 2), [["a", "b"], ["c"]])
assert.deepEqual(values, [1, 2, 3, 4, 5])
for (const size of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => chunk(values, size))`
    : `const { parseDuration } = await import(${JSON.stringify(module)})
for (const [value, want] of [["0ms", 0], ["0s", 0], ["1ms", 1], ["2s", 2000], ["9007199254740991ms", Number.MAX_SAFE_INTEGER], ["9007199254740s", 9007199254740000]]) assert.equal(parseDuration(value), want)
for (const value of ["", "-1ms", "+1s", "1.5s", " 1ms", "1ms ", "1m", "9007199254740992ms", "9007199254741s", "999999999999999999999999ms"]) assert.throws(() => parseDuration(value))`
  const oracle = join(dirname(directory), `oracle-${scenario}.ts`)
  await writeFile(oracle, `import assert from "node:assert/strict"\n${assertions}\nconsole.log("Independent fixture boundaries passed")\n`)
  const child = Bun.spawn([process.execPath, oracle], { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { passed: exit === 0, output: (stdout + stderr).slice(-10_000) }
  } finally { clearTimeout(timeout) }
}

export interface EvaluationCaseReport { scenario: EvaluationScenario; directory: string; evidence?: EvaluationEvidence; observedRun?: Run; score?: EvaluationScore; primaryResponse?: string; error?: string; cleanupErrors?: string[]; cleanupSettledSessions?: string[] }
export interface EvaluationReport { root: string; model: string; hostVersion: string; localSourceHash: string; promptVersions: string[]; budget: Limits; maxObservedCost: number; costPolicy: string; requestCount: null; cases: EvaluationCaseReport[]; usage: ReturnType<typeof evaluationUsage>; failure?: string }

export async function runModelEvaluation(args: string[], runtime: { root?: string; fetch?: typeof fetch } = {}): Promise<EvaluationReport> {
  const options = parseEvaluationOptions(args)
  const authorization = process.env.OPENCODE_EVAL_AUTHORIZATION
  const client = OpenCode.make({ baseUrl: options.url, ...(runtime.fetch ? { fetch: runtime.fetch } : {}), ...(authorization ? { headers: { Authorization: authorization } } : {}) })
  const info = await client.server.info({ signal: AbortSignal.timeout(5_000) })
  assertHostVersion(info.version)
  const catalog = await client.model.list({}, { signal: AbortSignal.timeout(5_000) })
  const selected = catalog.data.find(model => model.providerID === options.model.providerID && model.id === options.model.id)
  if (!selected || !selected.capabilities.tools) throw new Error(`Model ${options.modelReference} is not available as a connected tool-capable model`)
  if (options.model.variant && !selected.variants.some(variant => variant.id === options.model.variant)) throw new Error(`Model variant ${options.modelReference} is not available`)
  const base = resolve(".spike")
  if (!runtime.root) await mkdir(base, { recursive: true })
  const root = runtime.root ? resolve(runtime.root) : await mkdtemp(join(base, "model-evaluation-"))
  await mkdir(root, { recursive: true })
  const sessions = new Map<string, EvaluationSession>()
  const report: EvaluationReport = {
    root, model: options.modelReference, hostVersion: info.version, localSourceHash: (await manifest(resolve(import.meta.dir, ".."))).hash, promptVersions: [], budget: options.limits, maxObservedCost: options.maxCost,
    costPolicy: "Observed session cost is an accounting stop, not a hard spending ceiling. In-flight requests can overshoot; auxiliary provider requests may be unobservable. Unknown observed costs stop further work. Runtime limits apply per scenario; the observed USD allowance applies to the whole suite.",
    requestCount: null, cases: [], usage: evaluationUsage([]),
  }
  const save = async () => {
    report.usage = evaluationUsage([...sessions.values()])
    const safe = sanitizeEventData(report) as EvaluationReport
    await writeFile(join(root, "evaluation.json"), JSON.stringify(safe, null, 2) + "\n")
    const lines = [`# Model evaluation evidence`, `Model: ${safe.model}. Host: ${safe.hostVersion}. Local source: ${safe.localSourceHash}.`, safe.costPolicy, `Observed cost: ${safe.usage.cost ?? "unknown"}; known subtotal: ${safe.usage.knownCost}. Tokens: ${safe.usage.tokens ?? "unknown"}. Provider request count: unknown.`]
    if (safe.failure) lines.push(`Stopped: ${safe.failure}`)
    for (const item of safe.cases) {
      lines.push(`## ${item.scenario}`, `Outcome: ${item.evidence?.run.status ?? "not established"}. Independent checks: ${item.score?.passed ? "passed" : "not passed"}. Prose quality requires human review.`)
      if (item.error) lines.push(item.error)
      if (item.cleanupSettledSessions?.length) lines.push(`Native settlement confirmed for: ${item.cleanupSettledSessions.join(", ")}.`)
      for (const error of item.cleanupErrors ?? []) lines.push(`- Cleanup uncertainty: ${error}`)
      if (item.observedRun) lines.push(`Last observed run before cleanup: ${item.observedRun.status}. Its snapshot is retained in evaluation.json.`)
      for (const check of item.score?.checks ?? []) lines.push(`- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
      for (const criterion of item.score?.quality ?? []) lines.push(`- Needs review — ${criterion.criterion}: ${criterion.expected}`)
      if (item.primaryResponse) lines.push(`### Primary response`, item.primaryResponse)
    }
    await writeFile(join(root, "evaluation.md"), lines.join("\n\n") + "\n")
  }
  const guard = () => {
    const usage = evaluationUsage([...sessions.values()])
    if (usage.cost === null) throw new Error(`Observed cost is unknown for ${usage.unknownCostSessions.join(", ")}; evaluation stopped`)
    if (usage.knownCost >= options.maxCost) throw new Error("Observed cost allowance exhausted; evaluation stopped before further model work")
  }
  const rpc = client.rpc(UltraRpc)
  try {
    for (const scenario of options.scenarios) {
      guard()
      const directory = join(root, scenario), item: EvaluationCaseReport = { scenario, directory }
      report.cases.push(item)
      const prompt = await prepareEvaluationFixture(scenario, directory, options), before = await manifest(directory)
      const location = { directory }, request = () => ({ location, signal: AbortSignal.timeout(5_000) })
      const effective = await rpc.config({}, request()) as { config: ReturnType<typeof parseConfig>; promptVersion: string }
      for (const role of roles) if ((effective.config.models.roles?.[role] ?? effective.config.models.default) !== options.modelReference) throw new Error(`Effective ${role} model differs from explicit evaluation selection`)
      for (const stage of stages) if ((effective.config.models.stages?.[stage] ?? effective.config.models.default) !== options.modelReference) throw new Error(`Effective ${stage} model differs from explicit evaluation selection`)
      for (const [name, bound] of Object.entries(options.limits)) if (effective.config.limits[name as keyof Limits] !== bound) throw new Error(`Effective ${name} budget differs from explicit evaluation allowance`)
      if (!report.promptVersions.includes(effective.promptVersion)) report.promptVersions.push(effective.promptVersion)
      let parentId: string | undefined, run: Run | undefined, interrupted: EvaluationEvidence["interrupted"]
      const scenarioSessions = new Set<string>()
      const readFamily = async () => {
        if (!parentId) return []
        const all: EvaluationSession[] = [], family = new Set([parentId, ...scenarioSessions])
        let cursor: string | undefined
        do {
          const page = await client.session.list({ directory, limit: 100, order: "asc", ...(cursor ? { cursor } : {}) }, { signal: AbortSignal.timeout(5_000) })
          all.push(...page.data); cursor = page.cursor.next ?? undefined
        } while (cursor)
        let changed = true
        while (changed) {
          changed = false
          for (const session of all) if (session.parentID && family.has(session.parentID) && !family.has(session.id)) { family.add(session.id); changed = true }
        }
        const result = all.filter(session => family.has(session.id))
        for (const session of result) { scenarioSessions.add(session.id); sessions.set(session.id, session) }
        const requiredIds = [parentId, ...scenarioSessions, run?.supervisorSessionId, ...(run?.supervisorHistory ?? []), ...(run?.tasks.flatMap(task => task.attempts.map(attempt => attempt.sessionId)) ?? [])].filter((id): id is string => !!id)
        for (const id of requiredIds) if (!result.some(session => session.id === id)) {
          const session = await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(5_000) })
          result.push(session); scenarioSessions.add(session.id); sessions.set(session.id, session)
        }
        return result
      }
      try {
        const parent = await client.session.create({ location, agent: "ultra", model: options.model, title: `Ultra evaluation: ${scenario}` }, { signal: AbortSignal.timeout(5_000) })
        parentId = parent.id; scenarioSessions.add(parent.id); sessions.set(parent.id, parent); guard()
        await client.session.prompt({ sessionID: parent.id, text: prompt }, { signal: AbortSignal.timeout(5_000) })
        const deadline = Date.now() + options.limits.runMs
        const remainingMs = () => {
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw new Error("Evaluation scenario exhausted its explicit time allowance")
          return remaining
        }
        for (;;) {
          const saved = await rpc.status({}, request()) as { runs: Run[] }
          const admitted = saved.runs.filter(candidate => candidate.parentSessionId === parent.id)
          if (admitted.length > 1) throw new Error("One evaluation request admitted multiple workflows")
          run = admitted[0]
          await readFamily(); guard()
          remainingMs()
          const completed = run?.tasks.filter(task => task.status === "succeeded" && task.attempts.some(attempt => attempt.id === task.acceptedAttemptId && attempt.status === "succeeded")) ?? []
          const successor = run?.tasks.find(task => task.attempts.some(attempt => attempt.status === "running") && task.spec.dependencies.some(id => completed.some(task => task.spec.id === id)))
          if (scenario === "interrupted" && !interrupted && run?.supervisorSessionId && successor) {
            const interruptedRunId = run.id, supervisorId = run.supervisorSessionId, acceptedAttemptIds = completed.map(task => task.acceptedAttemptId!)
            await client.session.interrupt({ sessionID: supervisorId, resume: false }, { signal: AbortSignal.timeout(5_000) })
            await client.session.wait({ sessionID: supervisorId }, { signal: AbortSignal.timeout(5_000) })
            const snapshot = await client.session.get({ sessionID: supervisorId }, { signal: AbortSignal.timeout(5_000) })
            interrupted = { supervisorId, acceptedAttemptIds, successorTaskId: successor.spec.id, nativeOutcome: snapshot.outcome ?? "unknown" }
            await readFamily(); guard()
            for (;;) {
              const saved = await rpc.status({ runId: interruptedRunId }, { location, signal: AbortSignal.timeout(Math.min(5_000, remainingMs())) }) as { run: Run }
              if (!saved.run || saved.run.id !== interruptedRunId || saved.run.parentSessionId !== parent.id) throw new Error("Interruption recovery status did not identify the owned workflow")
              run = saved.run
              remainingMs()
              if (["ready", "succeeded", "partial", "failed", "cancelled"].includes(run.status)) throw new Error(`Workflow reached ${run.status} during interruption before a recovery boundary; requested recovery was not demonstrated`)
              if (["recovering", "waiting_input", "paused", "waiting_budget"].includes(run.status)) {
                if (run.tasks.some(task => task.attempts.some(attempt => attempt.status === "ambiguous"))) throw new Error("Interruption recovery has ambiguous native launches; reconciliation is required before resume")
                break
              }
              await Bun.sleep(Math.min(500, remainingMs()))
            }
            await readFamily(); guard()
            await rpc.control({ text: `resume ${run.id}`, sessionId: parent.id }, { location, signal: AbortSignal.timeout(Math.min(5_000, remainingMs())) })
          }
          if (run && ["ready", "succeeded", "partial", "failed", "cancelled"].includes(run.status)) {
            if (scenario === "interrupted" && !interrupted) throw new Error("Interruption scenario did not obtain accepted predecessor work with a running dependent successor; requested recovery graph was not demonstrated")
            break
          }
          if (!run && sessions.get(parent.id)?.outcome === "succeeded") throw new Error("The model finished without admitting the requested project workflow")
          await Bun.sleep(500)
        }
        const descendants = (await readFamily()).filter(session => session.id !== parent.id)
        await Promise.all(descendants.map(session => client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(remainingMs()) })))
        await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(remainingMs()) })
        const family = await readFamily(); guard()
        const after = await manifest(directory)
        const oracle = scenario === "bugfix" || scenario === "feature" ? await checkEvaluationFixture(scenario, directory) : undefined
        item.evidence = { run: run!, before, after, sessions: family, ...(oracle ? { oracle } : {}), ...(interrupted ? { interrupted } : {}) }
        item.score = scoreEvaluation(scenario, item.evidence, options.model)
        const context = await client.session.context({ sessionID: parent.id }, { signal: AbortSignal.timeout(5_000) })
        item.primaryResponse = context.flatMap(message => message.type === "assistant" ? message.content.flatMap(content => content.type === "text" ? [content.text] : []) : []).join("\n\n")
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error)
        item.observedRun = run
        item.cleanupErrors = []; item.cleanupSettledSessions = []
        if (run) try { await rpc.control({ text: `cancel ${run.id}`, sessionId: parentId! }, request()) } catch (cleanup) { item.cleanupErrors.push(String(cleanup)) }
        for (const id of [parentId, run?.supervisorSessionId, ...(run?.supervisorHistory ?? []), ...(run?.tasks.flatMap(task => task.attempts.map(attempt => attempt.sessionId)) ?? [])]) if (id) scenarioSessions.add(id)
        const attempted = new Set<string>(), cleanupDeadline = Date.now() + 30_000
        for (;;) {
          try { await readFamily() } catch (cleanup) { item.cleanupErrors.push(`Descendant discovery failed; additional children remain unconfirmed: ${String(cleanup)}`) }
          const pending = [...scenarioSessions].filter(id => !attempted.has(id))
          if (!pending.length) break
          if (Date.now() >= cleanupDeadline) { item.cleanupErrors.push(`Native settlement remains unconfirmed for: ${pending.join(", ")}`); break }
          for (const id of pending) {
            attempted.add(id)
            try { await client.session.interrupt({ sessionID: id, resume: false }, { signal: AbortSignal.timeout(5_000) }) } catch (cleanup) { item.cleanupErrors.push(`${id} interruption unconfirmed: ${String(cleanup)}`) }
            try {
              await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(5_000) })
              item.cleanupSettledSessions.push(id)
            } catch (cleanup) { item.cleanupErrors.push(`${id} native settlement unconfirmed: ${String(cleanup)}`) }
          }
        }
        for (const id of scenarioSessions) try {
          sessions.set(id, await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(5_000) }))
        } catch (cleanup) {
          sessions.set(id, { ...sessions.get(id), id, cost: undefined, tokens: undefined })
          item.cleanupErrors.push(`${id} final usage unavailable: ${String(cleanup)}`)
        }
        throw error
      } finally { await save() }
    }
    await save(); return sanitizeEventData(report) as EvaluationReport
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error)
    await save(); throw error
  }
}

if (import.meta.main) {
  try {
    const report = await runModelEvaluation(Bun.argv.slice(2))
    console.log(`Evaluation evidence: ${join(report.root, "evaluation.json")}\nHuman quality review: ${join(report.root, "evaluation.md")}`)
    if (report.cases.some(item => !item.score?.passed)) process.exitCode = 1
  } catch (error) {
    console.error(sanitizeEventData(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}
