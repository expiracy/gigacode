import { Rpc } from "@opencode/plugin"
const object = { type: "object", additionalProperties: true } as const
const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false } as const)
const string = { type: "string", minLength: 1 } as const
/** RPC is a control/read plane. It never invents the ToolContext needed for native dispatch. */
export const UltraRpc = Rpc.define({ id: "ultra.open-code", methods: {
  status: { input: input({ runId: string }), output: object },
  inspect: { input: input({ runId: string, taskId: string }, ["runId"]), output: object },
  config: { input: input({}), output: object },
  control: { input: input({ text: string, sessionId: string }, ["text", "sessionId"]), output: object },
  export: { input: input({ runId: string }, ["runId"]), output: object },
}, events: {} })
