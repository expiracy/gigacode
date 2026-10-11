import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"
import plugin from "../src/plugin.ts"
import { ULTRA_AGENT_ID, ULTRA_PRIMARY_SYSTEM } from "../src/agents.ts"
import type { Run } from "../src/types.ts"

/** A public-plugin fixture: actual engine/store, native prelaunch progress, no provider calls. */
export async function agentModeFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ultra-agent-mode-")))
  const policy = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "private/**", effect: "deny" },
  ]
  const agents = new Map<string, any>([
    ["build", { id: "build", name: "Build", mode: "primary", hidden: false, permissions: structuredClone(policy) }],
    [ULTRA_AGENT_ID, { id: ULTRA_AGENT_ID, name: ULTRA_AGENT_ID, mode: "primary", hidden: false, system: ULTRA_PRIMARY_SYSTEM, model: { providerID: "fixture", id: "test" }, permissions: structuredClone(policy) }],
    ["ultra-supervisor", { id: "ultra-supervisor", mode: "subagent", hidden: true, permissions: [] }],
    ["ultra-worker", { id: "ultra-worker", mode: "subagent", hidden: true, permissions: [] }],
  ])
  const sessions = new Map<string, any>()
  const seed = (id: string, update: Record<string, unknown> = {}) => {
    const session = {
      id, projectID: "project", location: { directory }, agent: ULTRA_AGENT_ID,
      model: { providerID: "fixture", id: "test" }, permissions: [], time: {},
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
      ...update,
    }
    sessions.set(id, session)
    return session
  }
  seed("parent"); seed("other", { agent: "build" })
  const tools = new Map<string, any>(), hooks = new Map<string, any>()
  const synthetics: any[] = [], feedback: any[] = [], progress: any[] = [], dispatches: any[] = [], interrupts: string[] = []
  let beforeDispatch: ((input: any, context: any) => Promise<void>) | undefined
  tools.set("subagent", {
    id: "subagent", name: "subagent", description: "Native fixture background child",
    input: Schema.Struct({ agent: Schema.String, description: Schema.String, prompt: Schema.String, background: Schema.Boolean, model: Schema.String }),
    async execute(input: any, context: any) {
      if (beforeDispatch) await beforeDispatch(input, context)
      dispatches.push({ input: structuredClone(input), sessionID: context.sessionID, messageID: context.messageID, id: context.id })
      const id = `child_${dispatches.length}`
      seed(id, { parentID: context.sessionID, agent: input.agent })
      await context.progress({ sessionID: id })
      return { content: "Native background child accepted", output: { sessionID: id, status: "running" } }
    },
  })
  const register = async (name: string, callback?: any) => {
    if (callback) hooks.set(name, callback)
    return { async dispose() {} }
  }
  const context = {
    app: { version: "2.0.25" },
    location: { directory, project: { id: "project", directory } },
    options: { checks: [] },
    agent: {
      async list() { return { data: structuredClone([...agents.values()]) } },
      async transform(callback: any) {
        await callback({
          list() { return [...agents.values()] }, get(id: string) { return agents.get(id) },
          update(id: string, update: any) {
            if (!agents.has(id)) agents.set(id, { id, name: id, mode: "primary", hidden: false, permissions: [] })
            update(agents.get(id))
          },
          remove(id: string) { agents.delete(id) }, default() {},
        })
        return register("agents")
      },
    },
    command: { async transform(callback: any) { await callback({ add() {} }); return register("commands") } },
    tool: {
      async transform(callback: any) {
        await callback({
          list() { return [...tools.values()] }, get(id: string) { return tools.get(id) }, namespace() {},
          add(tool: any) { tools.set(tool.name, { id: tool.name, ...tool }) },
          update(id: string, update: any) { if (tools.has(id)) update(tools.get(id)) }, remove(id: string) { tools.delete(id) },
        })
        return register("tools")
      },
      async list() { return [...tools.values()] },
      async hook(name: string, callback: any) { return register(`tool.${name}`, callback) },
    },
    session: {
      async hook(name: string, callback: any) { return register(`session.${name}`, callback) },
      async get({ sessionID }: any) {
        const value = sessions.get(sessionID)
        if (!value) throw new Error(`Unknown native session: ${sessionID}`)
        return structuredClone(value)
      },
      async update({ sessionID, ...update }: any) { Object.assign(sessions.get(sessionID), structuredClone(update)); return structuredClone(sessions.get(sessionID)) },
      async synthetic(value: any) { synthetics.push(value) },
      async interrupt({ sessionID }: any) { interrupts.push(sessionID); sessions.get(sessionID).time.idle = Date.now() },
      async wait({ sessionID }: any) { return structuredClone(sessions.get(sessionID)) },
    },
    permission: {
      async hook(name: string, callback: any) { return register(`permission.${name}`, callback) },
      async list() { return [] },
    },
    model: { async list() { return { data: [{ providerID: "fixture", id: "test", variants: [], capabilities: { tools: true } }] } } },
    rpc: { async register(_contract: unknown, handlers: any) { hooks.set("rpc", handlers); return { ...await register("rpc"), events: { async emit(name: string, data: any) { feedback.push({ name, data }) } } } } },
    event: { subscribe({ signal }: { signal: AbortSignal }) { return { async *[Symbol.asyncIterator]() { if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })) } } } },
  }
  const cleanup = await plugin.setup(context as any)
  const read = <T>(query: string): T[] => {
    const db = new Database(join(directory, ".ultracode", "state.sqlite"), { readonly: true })
    try { return db.query<{ body: string }, []>(query).all().map(row => JSON.parse(row.body) as T) }
    finally { db.close() }
  }
  const toolContext = (update: Record<string, unknown> = {}) => ({
    sessionID: "parent", agent: ULTRA_AGENT_ID, messageID: "message_1", id: "call_1", signal: new AbortController().signal,
    async progress(value: any) { progress.push(value) }, ...update,
  })
  return {
    directory, policy, context, agents, sessions, tools, hooks, synthetics, feedback, progress, dispatches, interrupts, seed, toolContext,
    runs: () => read<Run>("SELECT body FROM runs ORDER BY rowid"),
    audit() {
      const db = new Database(join(directory, ".ultracode", "state.sqlite"), { readonly: true })
      try { return db.query<{ id: string; kind: string; body: string }, []>("SELECT id, kind, body FROM events ORDER BY seq").all().map(({ id, kind, body }) => ({ id, kind, data: JSON.parse(body) })) }
      finally { db.close() }
    },
    beforeDispatch(callback: (input: any, context: any) => Promise<void>) { beforeDispatch = callback },
    async shutdown() { await cleanup!() },
    async close() {
      try { await cleanup!() }
      finally {
        const root = realpathSync(tmpdir()), target = realpathSync(directory), child = relative(root, target)
        if (!child || isAbsolute(child) || child === ".." || child.startsWith("..\\") || child.startsWith("../") || !basename(target).startsWith("ultra-agent-mode-")) throw new Error("Unsafe agent mode test cleanup target")
        rmSync(target, { recursive: true, force: true })
      }
    },
  }
}
