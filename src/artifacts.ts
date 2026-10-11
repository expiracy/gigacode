import { mkdirSync } from "node:fs"
import { writeFile, rename, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { sanitizeEventData } from "./store.ts"
import { assertPlainPath, digest, inside } from "./workspace.ts"
import type { Run, StoredEvent } from "./types.ts"

export class ArtifactStore {
  readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
    assertPlainPath(this.root)
    mkdirSync(this.root, { recursive: true })
    assertPlainPath(this.root)
  }
  private path(runId: string, name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || name.includes("..")) throw new Error("Invalid artifact identity")
    const result = join(this.root, "runs", runId, name)
    if (!inside(this.root, result)) throw new Error("Artifact escaped state directory")
    return result
  }
  private async atomic(path: string, text: string) {
    if (!inside(this.root, path)) throw new Error("Artifact escaped state directory")
    assertPlainPath(path)
    await mkdir(resolve(path, ".."), { recursive: true })
    assertPlainPath(path)
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
    assertPlainPath(path)
    await rename(temporary, path)
    return path
  }
  async put(data: unknown): Promise<string> {
    const value = { redacted: true, completeReplay: false, data: sanitizeEventData(data) }
    const text = JSON.stringify(value, null, 2) + "\n"
    const path = join(this.root, "artifacts", `${digest(text)}.json`)
    return this.atomic(path, text)
  }
  async write(runId: string, name: string, data: unknown): Promise<string> {
    return this.atomic(this.path(runId, name), JSON.stringify({ redacted: true, completeReplay: false, data: sanitizeEventData(data) }, null, 2) + "\n")
  }
  async text(runId: string, name: string, text: string): Promise<string> {
    return this.atomic(this.path(runId, name), String(sanitizeEventData(text)))
  }
  async export(run: Run, events: StoredEvent[]) {
    const json = await this.write(run.id, "export.json", { schemaVersion: 1, run, events, limits: ["Credential patterns are redacted; unrecognized secrets may require manual redaction before sharing.", "Missing native event history cannot be replayed."] })
    const markdown = await this.text(run.id, "report.md", renderReport(run))
    const dashboard = await this.text(run.id, "dashboard.html", renderDashboard(run, events))
    return { json, markdown, dashboard, redacted: true, completeReplay: false }
  }
}

export function renderReport(run: Run): string {
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ")
  const reference = (attempt: Run["tasks"][number]["attempts"][number]) => `${attempt.model.ref.providerID}/${attempt.model.ref.id}${attempt.model.ref.variant ? `#${attempt.model.ref.variant}` : ""} (${attempt.model.origin})`
  const candidate = run.candidateHash ?? run.workspaceHash
  const accepted = run.tasks.flatMap(task => {
    const attempt = task.attempts.find(item => item.id === task.acceptedAttemptId)
    return task.status === "succeeded" && attempt?.status === "succeeded" ? [{ task, attempt }] : []
  })
  const currentAttempt = (item: typeof accepted[number]) => !item.task.spec.writes && item.attempt.workspaceHash === candidate
  const currentFinding = (item: typeof accepted[number]) => currentAttempt(item) && (run.repairRound === 0 || item.task.spec.role === "reviewer" && item.task.spec.stage === "review" && item.task.spec.id === `repair.review.${run.repairRound}`)
  const acceptedIds = new Set(accepted.map(item => item.attempt.id))
  const allAttempts = run.tasks.flatMap(task => task.attempts.map(attempt => ({ task, attempt })))
  const observedChecks = allAttempts.flatMap(item => item.attempt.checks.map(check => ({ ...item, check })))
  const latestChecks = new Map<string, typeof observedChecks[number]>()
  for (const item of observedChecks.filter(item => acceptedIds.has(item.attempt.id) && item.check.workspaceHash === candidate).toSorted((left, right) => left.check.finishedAt - right.check.finishedAt)) latestChecks.set(item.check.checkId, item)
  const currentChecks = [...latestChecks.values()]
  const currentCheckIds = new Set(currentChecks.map(item => item.check.id))
  const modelReports = accepted.filter(item => currentAttempt(item) && item.task.spec.stage === "reporting" && item.attempt.result)
  const lines = [`# ${run.id}`, "", `Status: **${run.status}** · Mode: ${run.mode} · Revision: ${run.revision}`, "", run.objective]
  for (const item of modelReports) lines.push("", `## Model report (${escape(item.task.spec.id)})`, "", `Source: ${escape(item.attempt.id)} · ${escape(reference(item.attempt))}`, "", item.attempt.result!.summary)
  lines.push("", "## Tasks", "", "| Task | State | Model | Attempts |", "| --- | --- | --- | --- |")
  for (const task of run.tasks) {
    const attempt = task.attempts.at(-1)
    lines.push(`| ${escape(task.spec.title)} | ${task.status} | ${attempt ? escape(reference(attempt)) : "—"} | ${task.attempts.length} |`)
  }
  lines.push("", "## Acceptance coverage", "", `Evidence below applies to the saved candidate ${escape(candidate)}. Native checks show the latest accepted result per configured check ID; this export does not inspect a live workspace.`, "")
  for (const criterion of run.criteria) {
    const checks = currentChecks.filter(item => item.check.criterionIds.includes(criterion.id))
    const assessments = accepted.filter(currentAttempt).flatMap(item => (item.attempt.result?.assessments ?? []).map(assessment => ({ ...item, assessment }))).filter(item => item.assessment.criterionId === criterion.id)
    lines.push(`- ${escape(criterion.id)} (${criterion.required ? "required" : "optional"}, ${criterion.kind}): ${escape(criterion.description)}`)
    for (const { check } of checks) lines.push(`  - Native check ${escape(check.checkId)}: ${check.outcome}, exit ${check.exit ?? "unknown"}, evidence ${escape(check.id)}`)
    for (const { assessment, attempt } of assessments) lines.push(`  - Model assessment (${escape(attempt.id)}): ${assessment.passed ? "accepted" : "not accepted"} — ${escape(assessment.explanation)}`)
    if (!checks.length && !assessments.length) lines.push("  - No current accepted evidence recorded.")
  }
  const findings = accepted.filter(currentFinding).flatMap(item => (item.attempt.result?.findings ?? []).map(finding => ({ ...item, finding })))
  const describeFinding = (item: typeof findings[number]) => `${escape(item.finding.id)}: ${escape(item.finding.description)} (${item.finding.blocking ? "blocking" : "advisory"}; ${item.finding.disposition ?? "unresolved"}; source ${escape(item.task.spec.id)} / ${escape(item.attempt.id)})`
  if (findings.length) lines.push("", "## Current findings", "", ...findings.map(item => `- ${describeFinding(item)}`))
  const history: string[] = []
  for (const { check, attempt } of observedChecks.filter(item => !currentCheckIds.has(item.check.id))) history.push(`- Historical native check ${escape(check.checkId)}: ${check.outcome}, exit ${check.exit ?? "unknown"}, evidence ${escape(check.id)}, workspace ${escape(check.workspaceHash)}, source ${escape(attempt.id)}`)
  for (const item of allAttempts.filter(item => !acceptedIds.has(item.attempt.id) || !currentAttempt(item))) for (const assessment of item.attempt.result?.assessments ?? []) history.push(`- Historical model assessment ${escape(assessment.criterionId)} (${escape(item.attempt.id)}): ${assessment.passed ? "accepted" : "not accepted"} — ${escape(assessment.explanation)}`)
  for (const item of allAttempts.filter(item => !acceptedIds.has(item.attempt.id) || !currentFinding(item))) for (const finding of item.attempt.result?.findings ?? []) history.push(`- Historical finding ${describeFinding({ ...item, finding })}`)
  if (history.length) lines.push("", "## Historical evidence and findings", "", "These observations belong to previous candidates, superseded results, or attempts the engine did not accept. They are retained for provenance and do not establish current acceptance or unresolved current findings.", "", ...history)
  if (run.errors.length) lines.push("", "## Recorded diagnostics", "", "Diagnostics retain earlier conditions and may describe failures subsequently retried or repaired. The run status and current evidence determine the saved outcome.", "", ...run.errors.map(error => `- ${escape(error)}`))
  lines.push("", "## Provenance", "", "Full prompts, model selection origins, native session IDs, attempts, checks, and events are in export.json. Model reports and assessments are claims separate from machine check results. Exports redact recognized credentials and are unsuitable for complete replay.", "")
  return lines.join("\n")
}

function renderDashboard(run: Run, events: StoredEvent[]): string {
  const data = JSON.stringify(sanitizeEventData({ run, events })).replaceAll("<", "\\u003c")
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ultra Open Code run</title><style>body{font:15px system-ui;margin:0;background:#f3f5f7;color:#17212b}main{max-width:1100px;margin:auto;padding:32px}h1{font-size:28px}.meta{color:#526273}button{font:inherit;text-align:left;border:1px solid #d5dce2;border-radius:6px;padding:14px;background:white;cursor:pointer}button:hover,button[aria-pressed=true]{border-color:#1868b7}.tasks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}small{display:block;color:#526273;margin-top:6px}.succeeded{border-left:5px solid #237747}.failed,.blocked{border-left:5px solid #b13434}.running{border-left:5px solid #1868b7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:20px;border-radius:6px;max-height:650px;overflow:auto}nav{display:flex;gap:12px;margin:24px 0}</style><main><h1 id="title"></h1><p id="objective"></p><p class="meta" id="meta"></p><nav><button id="state">Run details</button><button id="events">Event history</button></nav><section class="tasks" id="tasks"></section><h2 id="detail-title">Run details</h2><pre id="detail"></pre><p class="meta">Local exported snapshot. Recognized credentials are redacted. Refresh by exporting the run again.</p></main><script type="application/json" id="data">${data}</script><script>const data=JSON.parse(document.getElementById('data').textContent);const run=data.run;const show=(title,value)=>{document.getElementById('detail-title').textContent=title;document.getElementById('detail').textContent=JSON.stringify(value,null,2)};document.getElementById('title').textContent=run.id;document.getElementById('objective').textContent=run.objective;document.getElementById('meta').textContent=run.status+' · '+run.mode+' · revision '+run.revision;for(const task of run.tasks){const b=document.createElement('button');b.className=task.status;b.textContent=task.spec.title;const s=document.createElement('small');s.textContent=task.spec.stage+' · '+task.status+' · depends on '+(task.spec.dependencies.join(', ')||'nothing');b.append(s);b.onclick=()=>show(task.spec.id,task);document.getElementById('tasks').append(b)}document.getElementById('state').onclick=()=>show('Run details',run);document.getElementById('events').onclick=()=>show('Event history',data.events);show('Run details',run)</script></html>`
}
