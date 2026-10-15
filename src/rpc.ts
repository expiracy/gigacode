import { Rpc } from "@opencode/plugin"
const object = { type: "object", additionalProperties: true } as const
const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false } as const)
const string = { type: "string", minLength: 1 } as const
const scope = { type: "string", enum: ["project", "global"] } as const
export interface CommandResult { sessionId: string; command: string; result?: Record<string, unknown>; error?: string }
/** RPC is a control/read plane. It never invents the ToolContext needed for native dispatch. */
export const UltraRpc = Rpc.define({ id: "open-ultra-code", methods: {
  workflow: { input: input({ sessionId: string, runId: string }, ["sessionId"]), output: object },
  status: { input: input({ runId: string }), output: object },
  inspect: { input: input({ runId: string, taskId: string }, ["runId"]), output: object },
  config: { input: input({}), output: object },
  settings: { input: input({ sessionId: string, scope }, ["sessionId"]), output: object },
  saveSettings: { input: input({ sessionId: string, scope, revision: string, options: object, replaceAdvanced: { type: "boolean" } }, ["sessionId", "revision", "options"]), output: object },
  control: { input: input({ text: string, sessionId: string }, ["text", "sessionId"]), output: object },
  export: { input: input({ runId: string }, ["runId"]), output: object },
}, events: {
  commandResult: { schema: {
    type: "object", properties: { sessionId: string, command: { type: "string" }, result: object, error: string },
    required: ["sessionId", "command"], additionalProperties: false,
    oneOf: [{ required: ["result"] }, { required: ["error"] }],
  } },
} })
