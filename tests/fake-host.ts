import type { Attempt, AvailableModel, HostAdapter, Invocation, Run, TaskSpec, WorkerSnapshot } from "../src/types.ts"

export class FakeHost implements HostAdapter {
  catalog: AvailableModel[] = [{ providerID: "fixture", id: "test", variants: ["high"], tools: true }]
  hash = "workspace:0"
  sessionPrefix = "fake-session"
  sessions = new Map<string, WorkerSnapshot>()
  launches: { run: Run; attempt: Attempt; task: TaskSpec; invocation: Invocation; sessionId: string }[] = []
  interruptions: string[] = []
  publications: { id: string; text: string }[] = []
  publicationError?: Error
  beforeBind?: (run: Run, attempt: Attempt) => void | Promise<void>
  afterBind?: (sessionId: string) => void
  interruptState: WorkerSnapshot["state"] = "interrupted"
  async models() { return this.catalog }
  async workspace() { return this.hash }
  async launch(run: Run, attempt: Attempt, task: TaskSpec, invocation: Invocation, bind: (sessionId: string) => Promise<void>) {
    await this.beforeBind?.(run, attempt)
    const sessionId = `${this.sessionPrefix}-${this.launches.length + 1}`
    this.sessions.set(sessionId, { sessionId, state: "running" })
    await bind(sessionId)
    this.launches.push({ run: structuredClone(run), attempt: structuredClone(attempt), task: structuredClone(task), invocation, sessionId })
    this.afterBind?.(sessionId)
    return { sessionId }
  }
  async inspect(sessionId: string) { return this.sessions.get(sessionId) ?? { sessionId, state: "unknown" as const } }
  async interrupt(sessionId: string) {
    this.interruptions.push(sessionId)
    this.sessions.set(sessionId, { sessionId, state: this.interruptState })
  }
  async publish(_run: Run, id: string, text: string) {
    if (this.publicationError) throw this.publicationError
    if (!this.publications.some(item => item.id === id)) this.publications.push({ id, text })
  }
  settle(sessionId: string, state: WorkerSnapshot["state"] = "succeeded") {
    this.sessions.set(sessionId, { sessionId, state, workspaceHash: this.hash })
  }
}

/** Fake adapter boundary for deterministic engine tests; never used by the native plugin. */
export const invocation = (sessionId = "supervisor"): Invocation => ({
  sessionId, messageId: "test-message", callId: "test-call", signal: new AbortController().signal, native: {},
})
