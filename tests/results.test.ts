import { expect, test } from "bun:test"
import { Schema } from "effect"
import { parseTaskResult, taskResultSchema } from "../src/results.ts"
import { defaultExecutionPlan } from "../src/workflow.ts"

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
