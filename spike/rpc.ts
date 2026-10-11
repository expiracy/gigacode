import { Rpc } from "@opencode/plugin"

const object = { type: "object", additionalProperties: true } as const
const empty = { type: "object", properties: {}, additionalProperties: false } as const

/** Test-only control plane. No RPC handler creates a tool invocation context. */
export const CompatibilityRpc = Rpc.define({
  id: "ultra.compatibility",
  methods: {
    inspect: { input: empty, output: object },
    snapshot: { input: empty, output: object },
    history: {
      input: {
        type: "object",
        properties: { after: { type: "integer", minimum: 0 } },
        additionalProperties: false,
      },
      output: object,
    },
    claim: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: object,
    },
    replay: {
      input: {
        type: "object",
        properties: { eventID: { type: "string", minLength: 1 } },
        required: ["eventID"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  events: {},
})
