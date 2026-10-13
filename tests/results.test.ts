import { expect, test } from "bun:test"
import { Schema } from "effect"
import { parseTaskResult, submitInputSchema, taskResultSchema } from "../src/results.ts"
import { defaultExecutionPlan } from "../src/workflow.ts"
import type { Criterion } from "../src/types.ts"

test("model-visible result schema describes nested output and a complete execution proposal", () => {
  const document = Schema.toJsonSchemaDocument(Schema.Struct({ result: taskResultSchema }))
  const serialized = JSON.stringify(document)
  for (const field of ["summary", "findings", "blocking", "evidence", "assessments", "criterionId", "explanation", "artifacts", "needsInput", "proposal", "tasks", "dependencies", "ownedPaths", "criteria", "rationale"]) expect(serialized).toContain(`"${field}"`)
  const properties = (document.schema as any).properties.result.properties
  expect(properties.summary.type).toBe("string")
  expect(properties.findings.type).toBe("array")
  expect(properties.findings.items.properties.evidence.type).toBe("string")
  expect(properties.assessments.items.properties.passed.type).toBe("boolean")
  expect(properties.proposal.properties.tasks.items.properties.dependencies.type).toBe("array")
})

test("pure result parser validates nested arrays and preserves legitimate proposal data", () => {
  const input = {
    summary: "Inspected requested behavior",
    findings: [{ id: "gap", description: "A test needs attention", blocking: true, disposition: "deferred" as const, evidence: "tests/queue.test.ts:12" }],
    assessments: [{ criterionId: "request", passed: false, explanation: "The failing test establishes the remaining gap" }],
    artifacts: ["design.md"], needsInput: "Which ordering should equal priorities use?",
    proposal: defaultExecutionPlan("Fix queue", [{ id: "request", description: "Fix queue", required: true, kind: "assessment" }], []),
  }
  const parsed = parseTaskResult(input)
  expect(parsed).toEqual(input)
  expect(parsed).not.toBe(input)
  expect(parsed.proposal).not.toBe(input.proposal)
})

test("invalid shapes have corrective field-specific errors without persisting arbitrary output", () => {
  for (const [field, value] of [["findings", [{ id: "f", description: "Gap", blocking: true, evidence: {} }]], ["assessments", {}], ["artifacts", [123]], ["summary", "   "], ["needsInput", ""]] as const) {
    expect(() => parseTaskResult({ summary: "Observed", [field]: value })).toThrow(/Invalid task result/)
    expect(() => parseTaskResult({ summary: "Observed", [field]: value })).toThrow(field)
  }
  expect(() => parseTaskResult({ summary: "Observed", unexpected: true })).toThrow(/unexpected/)
  expect(() => parseTaskResult({ summary: "Observed", assessments: [{ criterionId: "request", passed: true, explanation: "Evidence" }, { criterionId: "request", passed: false, explanation: "Contradictory evidence" }] })).toThrow(/Duplicate assessment/)
  try {
    parseTaskResult({ summary: "Observed", findings: [{ id: "gap", description: "Gap", blocking: true, evidence: { secret: "sensitive-example-value" } }] })
  } catch (error) {
    expect(String(error)).not.toContain("sensitive-example-value")
  }
})

test("readonly observations and input requests do not require fabricated assessments or proposals", () => {
  expect(parseTaskResult({ summary: "Inspected the existing queue implementation" })).toEqual({ summary: "Inspected the existing queue implementation" })
  const request = { summary: "Equal-priority order needs a user decision", needsInput: "Should equal priorities preserve insertion order?" }
  expect(parseTaskResult(request)).toEqual(request)
})

test("only design planners and synthesizers receive the execution proposal schema", () => {
  for (const role of ["implementer", "reviewer", "verifier", "explorer", "researcher"] as const) {
    const schema = submitInputSchema({ role, stage: "design" })
    expect(JSON.stringify(schema)).not.toContain('"proposal"')
    for (const field of ["summary", "findings", "artifacts", "needsInput"]) expect(JSON.stringify(schema)).toContain(`"${field}"`)
    expect(JSON.stringify(schema).includes('"assessments"')).toBe(role !== "implementer")
  }
  for (const role of ["planner", "synthesizer"] as const) {
    expect(JSON.stringify(submitInputSchema({ role, stage: "design" }))).toContain('"proposal"')
    expect(JSON.stringify(submitInputSchema({ role, stage: "reporting" }))).not.toContain('"proposal"')
  }
  const original = JSON.stringify(submitInputSchema({ role: "reviewer", stage: "review" }))
  const changed = submitInputSchema({ role: "reviewer", stage: "review" }) as any
  changed.properties.result.properties.summary = {}
  expect(JSON.stringify(submitInputSchema({ role: "reviewer", stage: "review" }))).toBe(original)
})

test("submission schemas narrow assessments to saved assessment IDs and omit writer assessments", () => {
  const criteria: Criterion[] = [
    { id: "request", description: "Required behavior", kind: "assessment", required: true },
    { id: "compatibility", description: "Existing behavior", kind: "assessment", required: false },
    { id: "verification", description: "Native checks", kind: "check", required: true },
  ]
  const original = structuredClone(criteria)
  for (const role of ["supervisor", "explorer", "researcher", "planner", "implementer", "reviewer", "verifier", "synthesizer"] as const) {
    const properties = (submitInputSchema({ role, stage: "design" }, criteria) as any).properties.result.properties
    for (const field of ["summary", "findings", "artifacts", "needsInput"]) expect(properties).toHaveProperty(field)
    expect(Boolean(properties.proposal)).toBe(["planner", "synthesizer"].includes(role))
    if (role === "implementer") expect(properties.assessments).toBeUndefined()
    else expect(properties.assessments.items.properties.criterionId.enum).toEqual(["request", "compatibility"])
    expect(properties.needsInput.description).toContain("Omit this field when unused")
    expect(properties.needsInput.description).toContain("never submit an empty string")
    expect((submitInputSchema({ role, stage: "design" }, []) as any).properties.result.properties.assessments).toBeUndefined()
    expect((submitInputSchema({ role, stage: "design" }, criteria.filter(criterion => criterion.kind === "check")) as any).properties.result.properties.assessments).toBeUndefined()
  }
  expect(criteria).toEqual(original)
  const changed = submitInputSchema({ role: "reviewer", stage: "review" }, criteria) as any
  changed.properties.result.properties.assessments.items.properties.criterionId.enum.push("verification")
  changed.properties.result.properties.needsInput.description = "Mutated"
  expect((submitInputSchema({ role: "reviewer", stage: "review" }, criteria) as any).properties.result.properties.assessments.items.properties.criterionId.enum).toEqual(["request", "compatibility"])
  const legacy = (submitInputSchema({ role: "reviewer", stage: "review" }) as any).properties.result.properties
  expect(legacy.assessments.items.properties.criterionId.enum).toBeUndefined()
  expect(legacy.needsInput.description).toContain("never submit an empty string")
})

test("registered result parsing still accepts legitimate historical writer assessments", () => {
  const input = { summary: "Implemented scoped duration validation", assessments: [{ criterionId: "request", passed: true, explanation: "The scoped parser change preserves the existing export." }] }
  expect(parseTaskResult(input)).toEqual(input)
  const properties = (Schema.toJsonSchemaDocument(Schema.Struct({ result: taskResultSchema })).schema as any).properties.result.properties
  expect(properties).toHaveProperty("assessments")
  expect(properties.needsInput.allOf[0].description).toBe("The specific missing user decision, when work cannot continue.")
  expect(properties.needsInput.description).toBeUndefined()
})
