import { Schema } from "effect"
import { roles, stages } from "./config.ts"
import type { TaskResult } from "./types.ts"

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
  checkIds: Schema.optionalKey(ids.annotate({ description: "Configured check IDs, available only to verification workers." })),
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

const decodeResult = Schema.decodeUnknownSync(taskResultSchema, { onExcessProperty: "error", reportInput: false })

/** Reject malformed claims before they become immutable candidates; no raw rejected values are echoed. */
export function parseTaskResult(input: unknown): TaskResult {
  let result: TaskResult
  try { result = structuredClone(decodeResult(input)) as TaskResult }
  catch (error) {
    throw new Error(`Invalid task result: ${error instanceof Error ? error.message : "Invalid structure"}. Correct the fields using ultra_submit's typed input schema and submit again.`)
  }
  for (const [field, entries] of [["assessment", result.assessments?.map(item => item.criterionId)], ["finding", result.findings?.map(item => item.id)]] as const) {
    if (entries && new Set(entries).size !== entries.length) throw new Error(`Invalid task result: Duplicate ${field} IDs. Submit one observed assessment or finding per ID.`)
  }
  return result
}
