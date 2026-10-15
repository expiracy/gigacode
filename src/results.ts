import { Schema } from "effect"
import { roles, stages } from "./config.ts"
import type { Attempt, Criterion, Run, Task, TaskResult, TaskSpec } from "./types.ts"

/** Isolated writer claims refer to their captured changes once native integration incorporates them. */
export function currentResult(run: Run, task: Task, attempt: Attempt): boolean {
  if (task.status !== "succeeded" || attempt.status !== "succeeded" || task.acceptedAttemptId !== attempt.id) return false
  const candidate = run.candidateHash ?? run.workspaceHash
  if ((task.spec.writes ? attempt.candidateHash : attempt.workspaceHash) === candidate) return true
  if (!task.spec.writes || attempt.worktree?.state !== "settled" || run.parallel?.integratedHash !== candidate) return false
  const integration = run.tasks.find(value => value.spec.id === run.parallel!.integrationTaskId)
  const applied = integration?.attempts.find(value => value.id === integration.acceptedAttemptId)
  return integration?.status === "succeeded" && applied?.status === "succeeded" && applied.integrationAppliedHash === candidate
}

const text = Schema.String.check(Schema.isPattern(/\S/), Schema.isPattern(/^[^\0]*$/))
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/))
const ids = Schema.Array(identifier)
const criterionSchema = Schema.Struct({
  id: identifier, description: text, required: Schema.Boolean, kind: Schema.Literals(["check", "assessment"]),
})
export const taskSchema = Schema.Struct({
  id: identifier, title: text, role: Schema.Literals(roles), stage: Schema.Literals(stages), instructions: text,
  dependencies: ids.annotate({ description: "IDs of tasks that must finish before this task starts." }),
  writes: Schema.Boolean,
  ownedPaths: Schema.optionalKey(Schema.Array(text).annotate({ description: "Relative project paths or patterns owned by an implementation writer." })),
  checkIds: Schema.optionalKey(ids.annotate({ description: "Explicit configured check IDs for role verifier and stage verification. Missing or empty IDs authorize no command execution. Assign RED checks as well as final verification." })),
  model: Schema.optionalKey(text.annotate({ description: "An explicitly authorized provider/model#variant reference, or inherit." })),
  acceptsFailures: Schema.optionalKey(Schema.Boolean), comparison: Schema.optionalKey(text),
})

/** Shape for model tool calling; graph admission still enforces policy and evidence requirements. */
export const planSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), rationale: text,
  criteria: Schema.Array(criterionSchema), tasks: Schema.Array(taskSchema).check(Schema.isMinLength(1)),
})

export const taskResultSchema = Schema.Struct({
  summary: text.annotate({ description: "Observed result, actual changes or evidence, and remaining limitations." }),
  proposal: Schema.optionalKey(planSchema.annotate({ description: "Optional execution graph from a design planner or synthesizer. Preserve immutable criteria and authorized scope." })),
  findings: Schema.optionalKey(Schema.Array(Schema.Struct({
    id: identifier, description: text, blocking: Schema.Boolean,
    disposition: Schema.optionalKey(Schema.Literals(["fixed", "rejected", "deferred"])),
    evidence: Schema.optionalKey(text.annotate({ description: "Concrete evidence for a finding or its resolution." })),
  }))),
  assessments: Schema.optionalKey(Schema.Array(Schema.Struct({
    criterionId: identifier.annotate({ description: "An existing assessment criterion ID from the run." }),
    passed: Schema.Boolean, explanation: text.annotate({ description: "Inspected evidence that supports the assessment, or the unresolved gap." }),
  }))),
  artifacts: Schema.optionalKey(Schema.Array(text).annotate({ description: "References to actual relevant artifacts." })),
  needsInput: Schema.optionalKey(text.annotate({ description: "The specific missing user decision, when work cannot continue." })),
})

const { proposal: _proposal, ...resultFields } = taskResultSchema.fields
const resultInput = Schema.toJsonSchemaDocument(Schema.Struct({ result: Schema.Struct(resultFields) })).schema
const proposalInput = Schema.toJsonSchemaDocument(Schema.Struct({ result: taskResultSchema })).schema

/** Advertise relevant fields and saved assessment IDs without changing registered runtime validation. */
export function submitInputSchema(task: Pick<TaskSpec, "role" | "stage">, criteria?: readonly Criterion[]) {
  const schema = structuredClone(task.stage === "design" && ["planner", "synthesizer"].includes(task.role) ? proposalInput : resultInput)
  const properties = (schema.properties as { result: { properties: Record<string, unknown> } }).result.properties
  const assessmentIds = criteria?.filter(criterion => criterion.kind === "assessment").map(criterion => criterion.id)
  if (task.role === "implementer" || assessmentIds?.length === 0) delete properties.assessments
  else if (assessmentIds) (properties.assessments as { items: { properties: { criterionId: { enum?: string[] } } } }).items.properties.criterionId.enum = assessmentIds
  const needsInput = properties.needsInput as { description: string }
  needsInput.description = "The specific missing user decision, when work cannot continue. Omit this field when unused; never submit an empty string."
  return schema
}

const decodeResult = Schema.decodeUnknownSync(taskResultSchema, { onExcessProperty: "error", reportInput: false })

/** Reject malformed claims before they become immutable candidates; no raw rejected values are echoed. */
export function parseTaskResult(input: unknown): TaskResult {
  let result: TaskResult
  try { result = structuredClone(decodeResult(input)) as TaskResult }
  catch (error) {
    throw new Error(`Invalid task result: ${error instanceof Error ? error.message : "Invalid structure"}. Correct the fields using ultraopencode_submit's typed input schema and submit again.`)
  }
  for (const [field, entries] of [["assessment", result.assessments?.map(item => item.criterionId)], ["finding", result.findings?.map(item => item.id)]] as const) {
    if (entries && new Set(entries).size !== entries.length) throw new Error(`Invalid task result: Duplicate ${field} IDs. Submit one observed assessment or finding per ID.`)
  }
  return result
}
