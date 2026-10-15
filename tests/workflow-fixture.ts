import type { Criterion, Plan, TaskResult, Workflow } from "../src/types.ts"

type ToolCall = { name: string; arguments: Record<string, unknown> }
export interface PrimaryScript {
  /** Match only the latest human prompt, never a worker's inherited objective. */
  prompt: string
  toolCalls: ToolCall[]
  text?: string
}
export interface WorkflowRequest {
  id: number
  model: string
  marker: "start" | "supervisor" | "task" | "primary" | "ordinary"
  runId?: string
  taskId?: string
  role?: string
  stage?: string
  calls: string[]
  tools: string[]
  primaryScriptId?: string
  system?: string
  error?: string
  state: "pending" | "held" | "completed" | "aborted" | "failed"
  hold?: string
}
export interface WorkflowFixture {
  baseURL: string
  requests: WorkflowRequest[]
  prelaunches: WorkflowPrelaunch[]
  scriptPrimary(script: PrimaryScript): string
  holdNext(marker: WorkflowRequest["marker"], role?: string): string
  holdPrelaunch(role: string): string
  release(key: string): void
  stop(): Promise<void>
}
export interface WorkflowPrelaunch {
  key: string
  role: string
  state: "armed" | "held" | "released" | "aborted"
  runId?: string
  taskId?: string
  attemptId?: string
  sessionId?: string
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(text).join("\n")
  if (value && typeof value === "object" && "text" in value) return text(value.text)
  return ""
}
function criteria(prompt: string): Criterion[] {
  const marker = "Immutable required criteria and acceptance coverage:"
  const markerOffset = prompt.indexOf(marker)
  const start = prompt.indexOf("[", markerOffset + marker.length)
  if (markerOffset < 0 || start < 0) throw new Error("Native worker prompt omitted its immutable criteria")
  let depth = 0, quoted = false, escaped = false
  for (let offset = start; offset < prompt.length; offset++) {
    const character = prompt[offset]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === "[") depth++
    else if (character === "]" && --depth === 0) return JSON.parse(prompt.slice(start, offset + 1)) as Criterion[]
  }
  throw new Error("Native worker criteria JSON was incomplete")
}
/** Explicit test graph; production task selection never inspects fixture objectives. */
export function fixturePlanningWorkflow(objective: string): Workflow {
  return {
    rationale: "This regression needs independent project and external-contract branches before design.",
    tasks: [
      { id: "explore", title: "Inspect project and constraints", role: "explorer", stage: "discovery", instructions: `Inspect relevant code and existing tests for: ${objective}`, dependencies: [], writes: false },
      { id: "research", title: "Research uncertain external contracts", role: "researcher", stage: "discovery", instructions: `Establish relevant external API contracts for: ${objective}`, dependencies: [], writes: false },
      { id: "design", title: "Design the requested behavior", role: "planner", stage: "design", instructions: `Use the independent findings to propose the design for: ${objective}`, dependencies: ["explore", "research"], writes: false },
    ],
  }
}

export function fixtureExecutionWorkflow(machineChecks = true): Workflow {
  return {
    rationale: "The fixture has one known file change, requiring only implementation, independent review and native verification.",
    tasks: [
      { id: "native.implement", title: "Implement fixture", role: "implementer", stage: "implementation", instructions: "Write implemented.txt containing native implementation verified followed by a newline.", dependencies: [], writes: true, ownedPaths: ["implemented.txt"] },
      { id: "native.review", title: "Review fixture", role: "reviewer", stage: "review", instructions: "Read the fixture candidate and independently assess the required criteria.", dependencies: ["native.implement"], writes: false },
      { id: "native.verify", title: "Verify fixture", role: "verifier", stage: "verification", instructions: machineChecks ? "Execute fixture-check through ultraopencode_check and report the actual result." : "Report that machine checks are disabled and assess available read-only evidence.", dependencies: ["native.implement"], writes: false, checkIds: machineChecks ? ["fixture-check"] : [] },
    ],
  }
}

function proposal(required: Criterion[], machineChecks = true): Plan {
  const verification = { id: "verification", description: "The configured native verification command passes.", required: true, kind: "check" as const }
  return {
    revision: 2,
    criteria: [...required, ...(!machineChecks || required.some(value => value.id === verification.id) ? [] : [verification])],
    ...fixtureExecutionWorkflow(machineChecks),
  }
}

/** Loopback protocol fixture: it emits real tool calls without using a paid model. */
export function createWorkflowFixture(options: { writePaths?: Record<string, string> } = {}): WorkflowFixture {
  const requests: WorkflowRequest[] = []
  const primaryScripts: (PrimaryScript & { id: string })[] = []
  const holds: { key: string; marker: WorkflowRequest["marker"]; role?: string; matched: boolean; released: boolean; resolve?: () => void }[] = []
  const prelaunches: WorkflowPrelaunch[] = []
  const prelaunchWaiters = new Map<string, () => void>()
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/v1/native-prelaunch") {
        const input = await request.json() as { role: string; runId: string; taskId: string; attemptId: string; sessionId: string }
        const hold = prelaunches.find(value => value.state === "armed" && value.role === input.role)
        if (!hold) return Response.json({ held: false })
        Object.assign(hold, { runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, sessionId: input.sessionId, state: "held" })
        await new Promise<void>(done => {
          prelaunchWaiters.set(hold.key, done)
          request.signal.addEventListener("abort", () => { hold.state = "aborted"; done() }, { once: true })
        })
        prelaunchWaiters.delete(hold.key)
        return Response.json({ held: true, state: hold.state })
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return Response.json({ error: { message: "Unknown fixture route" } }, { status: 404 })
      let record: WorkflowRequest | undefined
      try {
        const body = await request.json() as { model: string; stream: boolean; messages: Record<string, unknown>[]; tools?: { function?: { name?: string } }[] }
        const lastUser = body.messages.findLastIndex(message => message.role === "user")
        const prompt = text(body.messages[lastUser]?.content)
        const completedCalls = body.messages.slice(lastUser + 1).flatMap(message => {
          if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return []
          return message.tool_calls.map(call => (call as { function?: { name?: string } }).function?.name).filter((name): name is string => typeof name === "string")
        })
        const start = /^ULTRA_START_INTENT\s+([^\r\n]+)/m.exec(prompt)
        const supervisor = /^ULTRA_SUPERVISOR\s+([^\r\n]+)/m.exec(prompt)
        const worker = /^ULTRA_TASK_META\s+([^\r\n]+)/m.exec(prompt)
        record = { id: requests.length + 1, model: body.model, marker: start ? "start" : supervisor ? "supervisor" : worker ? "task" : "ordinary", calls: [], tools: (body.tools ?? []).flatMap(tool => typeof tool.function?.name === "string" ? [tool.function.name] : []), state: "pending" }
        requests.push(record)
        let calls: ToolCall[] = []
        let responseText = "Workflow fixture turn complete."
        if (start || supervisor) {
          const meta = JSON.parse((start ?? supervisor)![1]!) as { runId: string; intentId: string }
          record.runId = meta.runId
          const name = start ? "ultraopencode_start" : "ultraopencode_execute"
          if (!completedCalls.includes(name)) calls = [{ name, arguments: { runId: meta.runId, intentId: meta.intentId } }]
        } else if (worker) {
          const meta = JSON.parse(worker[1]!) as { runId: string; taskId: string; attemptId: string; role: string; stage: string }
          Object.assign(record, { runId: meta.runId, taskId: meta.taskId, role: meta.role, stage: meta.stage })
          const required = criteria(prompt)
          const directory = /^Directory: (.+)$/m.exec(prompt)?.[1]
          if (!directory) throw new Error("Native worker prompt omitted its directory")
          const internal = record.tools.includes("ultraopencode_prepare") ? "ultraopencode_prepare" : record.tools.includes("ultraopencode_integrate") ? "ultraopencode_integrate" : undefined
          const writePath = options.writePaths?.[meta.taskId] ?? "implemented.txt"
          if (internal) {
            if (!completedCalls.includes(internal)) calls = [{ name: internal, arguments: {} }]
            else if (!completedCalls.includes("ultraopencode_submit")) calls = [{ name: "ultraopencode_submit", arguments: { result: { summary: `Native ${internal} completed.` } } }]
          } else if (meta.role === "implementer" && prompt.includes("Automatic mode should coordinate") && !completedCalls.includes("read")) {
            calls = [{ name: "read", arguments: { path: directory.replaceAll("\\", "/") + "/implemented.txt" } }]
          } else if (meta.role === "implementer" && !completedCalls.includes("write")) {
            calls = [{ name: "write", arguments: { path: directory.replaceAll("\\", "/") + "/" + writePath, content: "native implementation verified\n" } }]
          } else if (meta.role === "reviewer" && meta.stage === "review" && !completedCalls.includes("read")) {
            calls = [{ name: "read", arguments: { path: directory.replaceAll("\\", "/") + "/" + (Object.values(options.writePaths ?? {})[0] ?? "implemented.txt") } }]
          } else if (meta.role === "verifier" && !completedCalls.includes("ultraopencode_check")) {
            calls = [{ name: "ultraopencode_check", arguments: { checkId: "fixture-check" } }]
          } else if (!completedCalls.includes("ultraopencode_submit")) {
            const result: TaskResult = { summary: `Scripted ${meta.role} ${meta.stage} result with native host execution.` }
            if (meta.stage === "design" || meta.role === "reviewer") {
              result.assessments = required.filter(value => value.kind === "assessment").map(value => ({ criterionId: value.id, passed: true, explanation: "The fixture design and candidate satisfy the requested scoped behavior." }))
            }
            if (meta.stage === "design" && ["planner", "synthesizer"].includes(meta.role)) result.proposal = proposal(required, !prompt.includes("GLOBAL_INSTALL_PROJECT_NO_CHECKS"))
            if (meta.role === "reviewer") result.findings = []
            calls = [{ name: "ultraopencode_submit", arguments: { result } }]
          }
        } else {
          // Auxiliary title generation carries the same prompt but no tools.
          // Deliberate unavailable-tool scripts still exercise a real model
          // request when it advertises other native tools.
          const script = record.tools.length ? primaryScripts.find(value => prompt.includes(value.prompt)) : undefined
          if (script) {
            record.marker = "primary"
            record.primaryScriptId = script.id
            record.system = body.messages.filter(message => ["system", "developer"].includes(String(message.role))).map(message => text(message.content)).join("\n")
            responseText = script.text ?? responseText
            // A tool result continuation completes the scripted primary turn;
            // duplicate calls must be explicit in the first response.
            if (completedCalls.length === 0) calls = script.toolCalls
          }
        }
        record.calls = calls.map(call => call.name)
        const requestId = record.id
        const toolCalls = calls.map((call, index) => ({ id: `workflow_${requestId}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
        const id = `workflow-completion-${record.id}`
        const created = Math.floor(Date.now() / 1_000)
        const activeRecord = record
        const hold = holds.find(value => !value.matched && value.marker === activeRecord.marker && (!value.role || value.role === activeRecord.role))
        if (hold) { hold.matched = true; activeRecord.hold = hold.key; activeRecord.state = "held" }
        const wait = async () => { if (hold && !hold.released) await new Promise<void>(done => { hold.resolve = done }) }
        if (!body.stream) {
          await wait()
          activeRecord.state = "completed"
          return Response.json({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: calls.length ? null : responseText, ...(calls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
        }
        let cancelled = false
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const frame = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
            const chunk = (delta: unknown, finish_reason: string | null = null) => frame({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
            chunk({ role: "assistant" })
            const aborted = () => { cancelled = true; activeRecord.state = "aborted"; hold?.resolve?.() }
            request.signal.addEventListener("abort", aborted, { once: true })
            void (async () => {
              try {
                await wait()
                if (cancelled) { try { controller.close() } catch { /* already disconnected */ }; return }
                if (!calls.length) chunk({ content: responseText })
                for (const [index, call] of toolCalls.entries()) {
                  chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] })
                  for (let offset = 0; offset < call.function.arguments.length; offset += 11) chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments.slice(offset, offset + 11) } }] })
                }
                chunk({}, calls.length ? "tool_calls" : "stop")
                frame({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
                activeRecord.state = "completed"
              } catch (error) {
                activeRecord.state = cancelled ? "aborted" : "failed"
                if (!cancelled) { activeRecord.error = String(error); try { controller.error(error) } catch { /* disconnected */ } }
              } finally { request.signal.removeEventListener("abort", aborted) }
            })()
          },
          cancel() { cancelled = true; activeRecord.state = "aborted"; hold?.resolve?.() },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      } catch (error) {
        if (record) { record.error = error instanceof Error ? error.message : String(error); record.state = "failed" }
        return Response.json({ error: { message: error instanceof Error ? error.message : String(error) } }, { status: 500 })
      }
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`, requests, prelaunches,
    scriptPrimary(script) {
      if (!script.prompt.trim()) throw new Error("Primary fixture prompt must not be empty")
      if (primaryScripts.some(value => value.prompt === script.prompt)) throw new Error("Duplicate primary fixture prompt")
      const id = `primary-${primaryScripts.length + 1}`
      primaryScripts.push({ ...structuredClone(script), id })
      return id
    },
    holdNext(marker, role) { const key = crypto.randomUUID(); holds.push({ key, marker, role, matched: false, released: false }); return key },
    holdPrelaunch(role) { const key = crypto.randomUUID(); prelaunches.push({ key, role, state: "armed" }); return key },
    release(key) {
      const prelaunch = prelaunches.find(value => value.key === key)
      if (prelaunch) { prelaunch.state = "released"; prelaunchWaiters.get(key)?.(); return }
      const hold = holds.find(value => value.key === key); if (!hold) throw new Error("Unknown fixture hold"); hold.released = true; hold.resolve?.()
    },
    stop: async () => {
      for (const hold of holds) { hold.released = true; hold.resolve?.() }
      for (const hold of prelaunches) { hold.state = "released"; prelaunchWaiters.get(hold.key)?.() }
      await server.stop(true)
    },
  }
}
