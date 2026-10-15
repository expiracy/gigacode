import { Plugin } from "@opencode/plugin"
import type { ToolContext, Info } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { CompatibilityRpc } from "./rpc.ts"

const HOST_VERSION = process.env.OPENCODE_TEST_VERSION ?? "2.0.25"
const SOURCE_REFERENCES: Record<string, string> = {
  "2.0.25": "b44eea9e204024db2b480a136ece29d790d5f593",
  "2.0.26": "d21b0790a6c146815f28fea604e41e922f009590",
  "2.0.28": "026b106bc5d41b679ffc413264229c340871e4d3",
}
if (!SOURCE_REFERENCES[HOST_VERSION]) throw new Error(`Unsupported compatibility candidate ${HOST_VERSION}`)
const SOURCE_COMMIT = SOURCE_REFERENCES[HOST_VERSION]!
const ProbeInput = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  waitMs: Schema.optionalKey(Schema.Number),
})
const BridgeInput = Schema.Struct({
  prompt: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.Boolean),
  failPrelaunch: Schema.optionalKey(Schema.Boolean),
  permissionMode: Schema.optionalKey(Schema.Literals(["deny-edit", "ask-edit", "inherit"])),
  model: Schema.optionalKey(Schema.String),
})
const CheckInput = Schema.Struct({ command: Schema.String })
type Rule = { action: string; resource: string; effect: "deny" | "allow" | "ask" }
type EventRow = { seq: number; event_id: string | null; kind: string; session_id: string | null; data: string; created: number }
type OwnedRow = { id: string; parent_id: string | null; role: string; project_id: string; directory: string }

/** The isolated fixture has no secrets. Still never export connection/auth/request objects. */
function sanitize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value !== "object") return String(value)
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|cookie|api.?key|credential|secret|headers/i.test(key) || /^(request|response)$/i.test(key)) {
      output[key] = "[redacted]"
    } else {
      output[key] = sanitize(entry)
    }
  }
  return output
}

function identity(context: ToolContext) {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.id,
    agent: context.agent,
    hasSignal: context.signal instanceof AbortSignal,
    aborted: context.signal.aborted,
  }
}

async function validateNative(tool: Info, value: unknown): Promise<unknown> {
  if (Schema.isSchema(tool.input)) return Schema.decodeUnknownPromise(tool.input)(value)
  const schema = tool.input as { "~standard"?: { validate: (value: unknown) => unknown } }
  if (schema["~standard"]) {
    const decoded = await schema["~standard"].validate(value) as { issues?: unknown; value?: unknown }
    if (decoded.issues) throw new Error(`Native ${tool.name} input rejected: ${JSON.stringify(decoded.issues)}`)
    return decoded.value
  }
  // Fail closed: this spike deliberately does not pretend JSON schema is a validator.
  throw new Error(`Native ${tool.name} schema is not supported by the pinned validation adapter`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(new Error("Compatibility probe interrupted"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      done()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export default Plugin.define({
  id: "open-ultra-code.compatibility",
  async setup(ctx) {
    if (ctx.app.version !== HOST_VERSION) {
      throw new Error(`Compatibility spike requires OpenCode ${HOST_VERSION}; received ${ctx.app.version}`)
    }
    // Every fixture location gets its own DB even when the host shares a project ID.
    const directory = resolve(ctx.location.directory)
    const requested = resolve(String(ctx.options.stateDirectory ?? join(directory, ".ultraopencode-spike")))
    const local = relative(directory, requested)
    if (local.startsWith("..") || isAbsolute(local)) throw new Error("Spike stateDirectory must be inside the fixture location")
    mkdirSync(requested, { recursive: true })
    const db = new Database(join(requested, "compatibility.sqlite"), { create: true })
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE,
        kind TEXT NOT NULL, session_id TEXT, data TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owned (
        id TEXT PRIMARY KEY, parent_id TEXT, role TEXT NOT NULL,
        project_id TEXT NOT NULL, directory TEXT NOT NULL
      );
    `)
    let closing = false
    const write = db.query("INSERT OR IGNORE INTO events (event_id,kind,session_id,data,created) VALUES (?,?,?,?,?)")
    const record = (kind: string, sessionID: string | null, data: unknown, eventID: string | null = null) => {
      if (closing) return false
      const result = write.run(eventID, kind, sessionID, JSON.stringify(sanitize(data)), Date.now())
      return result.changes === 1
    }
    const owned = (id: string) => db.query<OwnedRow, [string]>("SELECT * FROM owned WHERE id=?").get(id)
    const bind = async (sessionID: string, role: string, parentID?: string) => {
      const session = await ctx.session.get({ sessionID })
      if (session.projectID !== ctx.location.project.id || resolve(session.location.directory) !== directory) {
        throw new Error(`Refusing a session outside this spike location: ${sessionID}`)
      }
      if (parentID && session.parentID !== parentID) throw new Error("Native child belongs to another parent")
      db.query("INSERT OR IGNORE INTO owned VALUES (?,?,?,?,?)")
        .run(sessionID, session.parentID ?? null, role, session.projectID, directory)
      record("binding", sessionID, { sessionID, parentID: session.parentID, role, projectID: session.projectID, directory })
      return session
    }
    const registrations: { dispose: () => Promise<void> }[] = []
    const stop = new AbortController()
    record("setup", null, { hostVersion: ctx.app.version, sourceCommit: SOURCE_COMMIT, directory, projectID: ctx.location.project.id, runtime: process.versions.bun ?? "not-bun", sqlite: true })

    registrations.push(await ctx.command.transform(editor => editor.add({
      name: "ultraopencode-spike",
      description: "Record a deterministic compatibility command without a model request",
      async execute(input) {
        await bind(input.sessionID, "root")
        record("command", input.sessionID, { text: input.prompt.text, delivery: input.delivery, sessionID: input.sessionID })
      },
    })))

    registrations.push(await ctx.tool.transform(editor => {
      editor.add({
        name: "ultraopencode_probe",
        description: "Compatibility fixture: record genuine tool identity and optionally wait with interruption support",
        input: ProbeInput,
        output: Schema.Unknown,
        options: { codemode: false },
        async execute(input, context) {
          const ms = input.waitMs ?? 0
          if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) throw new Error("waitMs must be an integer between 0 and 60000")
          await bind(context.sessionID, "tool-caller")
          const start = Date.now()
          record("probe.started", context.sessionID, { ...identity(context), label: input.label, waitMs: ms })
          try {
            await context.progress({ label: input.label ?? "Compatibility probe", waitMs: ms })
            if (ms > 0) await sleep(ms, context.signal)
            context.signal.throwIfAborted()
            const output = { ...identity(context), label: input.label ?? "probe", elapsedMs: Date.now() - start }
            record("probe.completed", context.sessionID, output)
            return { content: JSON.stringify(output), output }
          } catch (error) {
            record("probe.interrupted", context.sessionID, { ...identity(context), elapsedMs: Date.now() - start, error: String(error) })
            throw error
          }
        },
      })
      editor.add({
        name: "ultraopencode_permission_probe",
        description: "Compatibility fixture: native shell permissions gate a fixed harmless check",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        options: { codemode: false, permission: "shell" },
        async execute(_input, context) {
          await bind(context.sessionID, "tool-caller")
          const native = (await ctx.tool.list()).find(tool => tool.name === "shell")
          if (!native) throw new Error("Required native shell tool is absent")
          const arguments_ = await validateNative(native, { command: "echo ULTRA_PERMISSION_PROBE", background: false, timeout: 5000 })
          record("permission-probe.started", context.sessionID, identity(context))
          // options.permission controls visibility only. The native executor performs the real assertion.
          const result = await native.execute(arguments_, context)
          record("permission-probe.executed", context.sessionID, { ...identity(context), nativeTool: native.id, result })
          return result
        },
      })
      editor.add({
        name: "ultraopencode_bridge",
        description: "Compatibility fixture: invoke the registered native subagent with this genuine invocation context",
        input: BridgeInput,
        output: Schema.Unknown,
        options: { codemode: false },
        async execute(input, context) {
          const parent = await bind(context.sessionID, "tool-caller")
          const native = (await ctx.tool.list()).find(tool => tool.name === "subagent")
          if (!native) throw new Error("Required native subagent tool is absent")
          const arguments_ = await validateNative(native, {
            agent: input.agent ?? "ultraopencode-worker",
            description: input.description ?? "UltraOpenCode compatibility worker",
            prompt: input.prompt,
            background: input.background ?? true,
            ...(input.model ? { model: input.model } : {}),
          })
          let childID: string | undefined
          let prelaunchReleased = false
          record("bridge.started", context.sessionID, { ...identity(context), nativeTool: native.id, input })
          try {
            const result = await native.execute(arguments_, {
              ...context,
              async progress(update) {
                if (typeof update.sessionID !== "string") throw new Error("Native prelaunch callback did not provide a child sessionID")
                if (childID && childID !== update.sessionID) throw new Error("Native callback changed child identity")
                childID = update.sessionID
                const child = await bind(childID, input.agent ?? "ultraopencode-worker", context.sessionID)
                record("bridge.prelaunch", childID, { ...identity(context), childID, inheritedPermissions: child.permissions })
                if (input.failPrelaunch) {
                  record("bridge.prelaunch.rejected", childID, { reason: "Explicit compatibility failure injection" })
                  throw new Error("Compatibility prelaunch denied before first prompt")
                }
                const mode = input.permissionMode ?? "deny-edit"
                const restrictions: Rule[] = mode === "inherit" ? [] : ["edit", "write", "patch", "shell"]
                  .map(action => ({ action, resource: "*", effect: mode === "ask-edit" ? "ask" : "deny" }))
                // Session allows follow agent rules in the host and can override an agent's own deny.
                // Install worker delegation limits on the child session itself, including inherit mode.
                if ((input.agent ?? "ultraopencode-worker") !== "ultraopencode-supervisor") {
                  restrictions.push({ action: "subagent", resource: "*", effect: "deny" })
                }
                if (restrictions.length > 0) {
                  // Append restrictions to the inherited snapshot: never replace it with a permissive baseline.
                  const inherited = child.permissions ?? parent.permissions ?? []
                  // An ask fixture must not turn an inherited deny into an ask via last-match precedence.
                  const permissions = [...inherited, ...restrictions, ...inherited.filter(rule => rule.effect === "deny")]
                  await ctx.session.update({ sessionID: childID, permissions })
                  const updated = await ctx.session.get({ sessionID: childID })
                  if (JSON.stringify(updated.permissions) !== JSON.stringify(permissions)) throw new Error("Native child restrictions did not persist")
                  record("bridge.permissions", childID, { mode, permissions })
                }
                await context.progress({ ...update, ultraPrelaunchBound: true })
                record("bridge.prelaunch.released", childID, { childID })
                prelaunchReleased = true
              },
            })
            if (!childID) throw new Error("Native prelaunch callback was not observed; unsupported host")
            const output = result.output as { sessionID?: unknown; status?: unknown } | undefined
            if (output?.sessionID !== childID || !["running", "completed"].includes(String(output.status))) {
              throw new Error("Native subagent result did not correlate to its prelaunch binding")
            }
            record("bridge.returned", context.sessionID, { ...identity(context), childID, result })
            return result
          } catch (error) {
            record("bridge.failed", context.sessionID, { ...identity(context), childID, error: String(error) })
            // A denied prelaunch leaves a recorded, unprompted native child. Settle before cleanup.
            if (childID && !prelaunchReleased) {
              const response = await ctx.session.interrupt({ sessionID: childID, resume: false })
              await ctx.session.wait({ sessionID: childID })
              const settled = await ctx.session.get({ sessionID: childID })
              record("bridge.failed.settled", childID, {
                interruption: response,
                waitReturned: true,
                outcome: settled.outcome ?? null,
                time: settled.time,
              })
            }
            throw error
          }
        },
      })
      editor.add({
        name: "ultraopencode_native_check",
        description: "Compatibility fixture: run the registered native shell and preserve its structured evidence",
        input: CheckInput,
        output: Schema.Unknown,
        options: { codemode: false },
        async execute(input, context) {
          await bind(context.sessionID, "tool-caller")
          const native = (await ctx.tool.list()).find(tool => tool.name === "shell")
          if (!native) throw new Error("Required native shell tool is absent")
          const arguments_ = await validateNative(native, { command: input.command, background: false, timeout: 5000 })
          record("native-check.started", context.sessionID, { ...identity(context), nativeTool: native.id, command: input.command })
          const result = await native.execute(arguments_, context)
          record("native-check.completed", context.sessionID, { ...identity(context), nativeTool: native.id, result })
          return result
        },
      })
    }))

    registrations.push(await ctx.tool.hook("execute.before", async event => {
      if (owned(event.sessionID)) record("tool.execute.before", event.sessionID, event)
    }))
    registrations.push(await ctx.tool.hook("execute.after", async event => {
      if (owned(event.sessionID)) record("tool.execute.after", event.sessionID, event)
    }))
    registrations.push(await ctx.permission.hook("evaluate", event => {
      if (owned(event.sessionID)) record("permission.evaluate", event.sessionID, event)
    }))
    registrations.push(await ctx.session.hook("model.request", event => {
      if (owned(event.sessionID)) record("model.request", event.sessionID, { sessionID: event.sessionID, agent: event.agent, model: event.model, kind: event.kind })
    }))
    registrations.push(await ctx.session.hook("prompt", event => {
      if (owned(event.sessionID)) record("session.prompt", event.sessionID, event)
    }))

    // Global subscriptions can include other projects/worktrees. Require BOTH location and ownership.
    const observer = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
          if (event.location && resolve(event.location.directory) !== directory) continue
          const data = event.data as Record<string, unknown>
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
          if (!sessionID || !owned(sessionID)) continue
          record(event.type, sessionID, event, event.id)
        }
      } catch (error) {
        if (!stop.signal.aborted) record("observer.failed", null, { error: String(error) })
      }
    })()

    registrations.push(await ctx.rpc.register(CompatibilityRpc, {
      async inspect() {
        const tools = await ctx.tool.list()
        return {
          hostVersion: ctx.app.version,
          sourceCommit: SOURCE_COMMIT,
          sqlite: true,
          runtime: process.versions.bun ?? null,
          directory,
          projectID: ctx.location.project.id,
          tools: tools.map(tool => ({ id: tool.id, name: tool.name, options: tool.options })),
          commands: await ctx.command.list(),
          sessions: db.query("SELECT * FROM owned").all(),
        }
      },
      async snapshot() {
        const bindings = db.query<OwnedRow, []>("SELECT * FROM owned").all()
        const sessions = []
        for (const binding of bindings) {
          try {
            const session = await ctx.session.get({ sessionID: binding.id })
            sessions.push({ ...binding, outcome: session.outcome ?? null, time: session.time, agent: session.agent ?? null, model: session.model ?? null, permissions: session.permissions ?? [] })
          } catch (error) {
            sessions.push({ ...binding, error: String(error) })
          }
        }
        return { sessions, eventCount: db.query("SELECT COUNT(*) AS count FROM events").get(), sqlite: true }
      },
      async history(input) {
        const after = Number((input as { after?: number }).after ?? 0)
        const rows = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq>? ORDER BY seq").all(after)
        return { events: rows.map(row => ({ ...row, data: JSON.parse(row.data) })), cursor: rows.at(-1)?.seq ?? after }
      },
      async claim(input) {
        const sessionID = (input as { sessionID: string }).sessionID
        await bind(sessionID, "root")
        return { sessionID, bound: true }
      },
      async replay(input) {
        const eventID = (input as { eventID: string }).eventID
        const row = db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id=?").get(eventID)
        if (!row) throw new Error("Replay requires an event already recorded from the host")
        const inserted = record(row.kind, row.session_id, JSON.parse(row.data), row.event_id)
        return { eventID, inserted }
      },
    }))

    return async () => {
      stop.abort()
      await observer
      record("cleanup", null, { directory })
      for (const registration of registrations.toReversed()) await registration.dispose()
      closing = true
      db.close()
    }
  },
})
