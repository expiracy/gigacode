export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Role = "supervisor" | "explorer" | "researcher" | "planner" | "implementer" | "reviewer" | "verifier" | "synthesizer"
export type Stage = "discovery" | "design" | "implementation" | "review" | "verification" | "reporting"
export type RunStatus = "starting" | "planning" | "ready" | "running" | "pausing" | "paused" | "waiting_input" | "waiting_budget" | "recovering" | "cancelling" | "succeeded" | "partial" | "failed" | "cancelled"
export type TaskStatus = "pending" | "running" | "waiting_permission" | "cancelling" | "succeeded" | "failed" | "cancelled" | "blocked" | "skipped"
export type AttemptStatus = "reserved" | "running" | "waiting_permission" | "cancelling" | "succeeded" | "failed" | "cancelled" | "ambiguous"
export interface Rule { action: string; resource: string; effect: "allow" | "ask" | "deny" }
export interface ModelRef { providerID: string; id: string; variant?: string }
export interface ModelSelection { ref: ModelRef; origin: string; requested: string }
export interface ModelOptions { default?: string; roles?: Partial<Record<Role, string>>; stages?: Partial<Record<Stage, string>> }
export interface AvailableModel extends ModelRef { variants: string[]; tools?: boolean }
export interface Limits { workers: number; runs: number; attempts: number; repairRounds: number; workerMs: number; runMs: number; elapsedMs: number; steps: number }
export interface CheckSpec { id: string; command: string; criterionIds: string[]; timeoutMs?: number }
export interface Config { models: ModelOptions; limits: Limits; checks: CheckSpec[]; parallelWrites: boolean; autoThreshold: number; prompts?: Partial<Record<Role, string>> }
export interface Criterion { id: string; description: string; required: boolean; kind: "check" | "assessment" }
export interface TaskSpec { id: string; title: string; role: Role; stage: Stage; instructions: string; dependencies: string[]; writes: boolean; ownedPaths?: string[]; acceptsFailures?: boolean; model?: string; checkIds?: string[]; comparison?: string }
export interface Plan { revision: number; tasks: TaskSpec[]; criteria: Criterion[]; rationale: string }
export interface Finding { id: string; description: string; blocking: boolean; disposition?: "fixed" | "rejected" | "deferred"; evidence?: string }
export interface TaskResult { summary: string; proposal?: Plan; findings?: Finding[]; assessments?: { criterionId: string; passed: boolean; explanation: string }[]; artifacts?: string[]; needsInput?: string; [key: string]: unknown }
export interface CheckEvidence { id: string; attemptId: string; taskId: string; sessionId: string; callId: string; checkId: string; command: string; criterionIds: string[]; cwd: string; startedAt: number; finishedAt: number; exit: number | null; outcome: "passed" | "failed" | "cancelled" | "unknown"; output: string; workspaceHash: string }
export interface Attempt { id: string; taskId: string; number: number; status: AttemptStatus; ownerEpoch: number; sessionId?: string; promptId?: string; inputHash: string; prompt: string; model: ModelSelection; createdAt: number; startedAt?: number; finishedAt?: number; result?: TaskResult; resultHash?: string; error?: string; workspaceHash: string; candidateHash?: string; checks: CheckEvidence[]; steps: number; tokens?: number; cost?: number }
export interface Task { spec: TaskSpec; status: TaskStatus; attempts: Attempt[]; acceptedAttemptId?: string }
export interface Run {
  id: string
  projectId: string
  directory: string
  parentSessionId: string
  supervisorSessionId?: string
  supervisorHistory?: string[]
  supervisorAttempt?: number
  intentId: string
  intentExpiresAt: number
  objective: string
  mode: "plan" | "execute"
  status: RunStatus
  previousStatus?: RunStatus
  phase: "planning" | "execution"
  revision: number
  plans: Plan[]
  proposal?: Plan
  tasks: Task[]
  criteria: Criterion[]
  capturedModel: ModelRef
  modelOptions: ModelOptions
  config: Config
  policy: Rule[]
  workspaceHash: string
  candidateHash?: string
  createdAt: number
  updatedAt: number
  activeMs: number
  activeSince?: number
  repairRound: number
  continuation: number
  ownerEpoch: number
  generation: number
  errors: string[]
  clarifications?: { taskId: string; question: string; answer: string; at: number }[]
  notifications: { id: string; text: string; delivered: boolean }[]
}
export interface StoredEvent { seq: number; id: string; projectId: string; runId?: string; taskId?: string; attemptId?: string; kind: string; createdAt: number; data: unknown }
export interface EventInput { id?: string; runId?: string; taskId?: string; attemptId?: string; kind: string; data?: unknown; createdAt?: number }
export interface Lease { projectId: string; owner: string; epoch: number; expiresAt: number }
export interface Store {
  create(run: Run): void
  get(id: string): Run | undefined
  list(projectId: string): Run[]
  mutate<T>(id: string, change: (run: Run) => T, fence?: Lease): T
  project<T>(projectId: string, change: (runs: Run[]) => T, fence?: Lease): T
  event(projectId: string, event: EventInput): boolean
  events(projectId: string, runId?: string, after?: number): StoredEvent[]
  lease(projectId: string, owner: string, now: number, ttlMs: number): Lease | undefined
  renew(lease: Lease, now: number, ttlMs: number): Lease
  release(lease: Lease): void
  close(): void
}
export interface WorkerSnapshot { sessionId: string; state: "running" | "waiting_permission" | "succeeded" | "failed" | "interrupted" | "unknown"; error?: string; tokens?: number; cost?: number; workspaceHash?: string }
export interface Invocation { signal: AbortSignal; sessionId: string; messageId: string; callId: string; native: unknown }
/** Only adapters with proof that native admission did not happen may release a reservation. */
export class NoLaunchError extends Error {
  constructor(message: string) { super(message); this.name = "NoLaunchError" }
}
/** A created child never passed prelaunch; native awaitIdle confirmed quiescence after cleanup. */
export class SettledLaunchError extends Error {
  constructor(readonly sessionId: string, message: string) { super(message); this.name = "SettledLaunchError" }
}
/** The native child identity is attested, but cleanup could not establish quiescence. */
export class UnsettledLaunchError extends Error {
  constructor(readonly sessionId: string, message: string) { super(message); this.name = "UnsettledLaunchError" }
}
export interface HostAdapter {
  models(): Promise<AvailableModel[]>
  workspace(directory: string): Promise<string>
  launch(run: Run, attempt: Attempt, task: TaskSpec, invocation: Invocation, bind: (sessionId: string) => Promise<void>): Promise<{ sessionId: string }>
  inspect(sessionId: string): Promise<WorkerSnapshot>
  interrupt(sessionId: string): Promise<void>
  publish(run: Run, id: string, text: string): Promise<void>
}
