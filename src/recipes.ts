import type { TaskSpec, Workflow } from "./types.ts"

export const recipeNames = ["deep-review", "bug-investigation", "cross-checked-research"] as const
export type RecipeName = typeof recipeNames[number]

export function recipeName(value: unknown): RecipeName {
  if (!recipeNames.includes(value as RecipeName)) throw new Error(`Unknown recipe: ${String(value)}`)
  return value as RecipeName
}

export function recipeWorkflow(name: RecipeName, _objective: string): Workflow {
  recipeName(name)
  const task = (id: string, title: string, role: TaskSpec["role"], instructions: string, dependencies: string[] = []): TaskSpec => ({
    id, title, role, stage: role === "reviewer" ? "review" : role === "synthesizer" || role === "planner" ? "design" : "discovery",
    instructions, dependencies, writes: false,
  })
  if (name === "bug-investigation") return {
    rationale: "An independent code trace and regression investigation establish the root cause before recommending a fix.",
    tasks: [
      task("trace", "Trace the failing behavior", "explorer", "Trace the observed failure through relevant code and callers. Identify the smallest root cause supported by evidence and distinguish it from symptoms or guesses. Do not run commands or modify files."),
      task("regressions", "Inspect regressions and competing explanations", "explorer", "Independently inspect tests, interfaces and boundary cases. Check competing explanations for the failure, compatibility constraints and the regression that would demonstrate the defect. Do not claim an unexecuted reproduction passed or failed."),
      task("diagnosis", "Reconcile the root cause and fix strategy", "planner", "Reconcile both investigations into an evidence-backed root cause, smallest change, affected callers and regression strategy. State unresolved questions and unexecuted checks honestly. An execution proposal is optional; preserve existing criteria and admitted scope.", ["trace", "regressions"]),
    ],
  }
  if (name === "cross-checked-research") return {
    rationale: "Independent primary-source and contrary-evidence research distinguishes versioned facts from assumptions.",
    tasks: [
      task("primary", "Establish primary contracts", "researcher", "Inspect relevant primary sources. Record exact versions, dates and citations, separate documented guarantees from assumptions, and explain the contract relevant to the request."),
      task("crosscheck", "Cross-check versions and contrary evidence", "researcher", "Independently look for contradictory evidence, version differences, limitations and counterexamples in primary sources. Record citations and distinguish obsolete behavior from the current requested contract."),
      task("report", "Reconcile research evidence", "synthesizer", "Reconcile both research branches with concrete citations and version boundaries. Explain contradictions and uncertainty, avoid unsupported conclusions, and assess coverage of the requested research. Do not fabricate implementation or machine verification. An execution proposal is optional only when the request warrants one.", ["primary", "crosscheck"]),
    ],
  }
  return {
    rationale: "Two complementary independent reviews feed an evidence-based report without modifying the project.",
    tasks: [
      task("behavior", "Review behavior and compatibility", "reviewer", "Inspect the relevant code and every caller against the requested behavior. Examine interfaces, backwards compatibility and acceptance coverage. Cite concrete paths and observations."),
      task("failures", "Review failure paths and regression risk", "reviewer", "Independently inspect error handling, boundary cases, security, resource lifetimes and existing tests. Report actionable findings with concrete evidence; do not invent passing tests."),
      task("report", "Reconcile review findings", "synthesizer", "Reconcile both independent reviews. Preserve evidence and unresolved findings, distinguish defects from uncertainty, and give prioritized actionable conclusions. Assess whether the requested review was completed; do not claim implementation or verification occurred. A corrective execution proposal is optional and must be justified by observed defects.", ["behavior", "failures"]),
    ],
  }
}
