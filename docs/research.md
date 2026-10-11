# Research and OpenCode 2 compatibility notes

Checked on 11 October 2026. These are source/documentation findings, not successful runtime integration tests.

## Claude's public behavior

Claude's dynamic workflows use generated JavaScript to coordinate agents in an isolated runtime. The public helpers include `agent`, `pipeline`, `parallel`, `phase`, and `log`. The documented interface exposes workflow progress, prompts, tool activity, results, pause/resume, cancellation, and saved workflows. Scripts cannot directly run shell commands or access the filesystem; agents perform that work. [Official workflows documentation](https://code.claude.com/docs/en/workflows).

Ultracode turns on automatic workflow selection. Current `/effort ultracode` behavior preserves reasoning effort, while launching with `--effort ultracode` also chooses `xhigh`. The exact private prompts and task-selection heuristics are not provided by these docs. [Official model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

Our recommendation differs deliberately: start with a validated declarative task graph and bounded revisions rather than executing arbitrary model-generated JavaScript. This is a product/design choice, not a claim of equivalent internals or full feature parity.

## The linked OpenUltraCode implementation

Inspected upstream revision: [2638f032698c9e8e68b624194c67eb6bd84ed909](https://github.com/norandom/OpenUltraCode/commit/2638f032698c9e8e68b624194c67eb6bd84ed909).

| Finding | Primary source |
| --- | --- |
| Workflow stages and delegation are instructions in prompt assets. | [Workflow skill](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/.opencode/skills/open-ultracode/SKILL.md) |
| Plugin hooks track failures, status, and request hints; they do not dispatch native sessions or implement a queue. | [hooks.ts](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/src/hooks.ts) |
| One project-local JSON snapshot is replaced atomically, without a transaction/CAS for concurrent read-modify-write updates. | [state.ts](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/src/state.ts) |
| Evidence does not bind a pass claim to a native tool call, execution time, exit status, or workspace digest. | [types.ts](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/src/types.ts), [verification.ts](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/src/verification.ts) |
| Asset and helper tests do not prove a real OpenCode 2 asynchronous lifecycle. | [readiness tests](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/tests/e2e-readiness.test.ts), [package.json](https://github.com/norandom/OpenUltraCode/blob/2638f032698c9e8e68b624194c67eb6bd84ed909/package.json) |

This supports an independent runtime implementation. It does not imply that its workflow prompts cannot be useful.

## Version baseline

The installed npm wrapper points to `@opencode/cli`; its package manifest reports **2.0.25**. The compatibility spike now verifies the same version through an isolated running server. [Runtime results](compatibility-spike.md) document the demonstrated capabilities and limits.

Immutable matching source: [b44eea9e204024db2b480a136ece29d790d5f593](https://github.com/anomalyco/opencode/commit/b44eea9e204024db2b480a136ece29d790d5f593).

Inspected development source reports **2.0.26**: [d21b0790a6c146815f28fea604e41e922f009590](https://github.com/anomalyco/opencode/commit/d21b0790a6c146815f28fea604e41e922f009590). This is not a promise that an update is available or that its runtime has been validated here.

OpenCode 2 uses the `@opencode/*` package family and a new plugin entrypoint. The legacy `@opencode-ai/sdk/v2` import does not demonstrate compatibility. [Official plugin migration guide](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1).

## Source-backed integration map

Names below refer to inspected host APIs; the engine's adapter interface in the design document is our own abstraction.

| Need | OpenCode 2 surface | Caveat |
| --- | --- | --- |
| Server plugin | `Plugin.define({ id, setup })` from `@opencode/plugin` | Pin matching official types. |
| Deterministic commands | `ctx.command.transform`, `editor.add({ name, execute })` | Executor receives session, prompt, delivery; not a tool context. |
| Custom tools | `ctx.tool.transform`, schema-bearing definitions | Execution receives real session, message, tool-call identity, signal, and progress. |
| Native workers | Registered `subagent` tool, `background: true` | Validates delegation; response is a running handle. |
| Session inspection | `ctx.session.get`, `ctx.session.context` | Narrower than the external client. |
| Stop / settle | `ctx.session.interrupt({ sessionID, resume: false })`, `wait` | Interruption acknowledgement precedes cleanup; idle does not establish success. |
| Permissions | `ctx.permission.list/get/reply`, `ctx.session.update({ permissions })` | Replacement and ordering require explicit narrowing. |
| Live events | `ctx.event.subscribe({ signal })` | Filter owned sessions across server locations; no replay guarantee. |
| Historical event replay | External client's `session.log` | Tested CLI returns synchronization markers without history; adapter persistence and native snapshot reconciliation are required. |
| Worktrees | `ctx.worktree.create/list/refresh/remove` with `projectID` | Native subagent location placement needs a separate validated strategy. |
| Optional terminal UI | `@opencode/plugin/tui` | UI is a client of runtime state. |
| Plugin RPC | `Rpc.define`, `ctx.rpc.register` | RPC events are live only; subscribers refresh durable state after reconnect. |

Relevant contracts: [command](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/command.ts), [tool](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/tool.ts), [session](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/session.ts), [permission](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/permission.ts), [protocol session routes](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/protocol/src/groups/session.ts). Public documentation: [client](https://dev.opencode.ai/v2/docs/build/client/), [RPC](https://dev.opencode.ai/v2/docs/build/plugins/rpc/), [CLI plugins](https://dev.opencode.ai/v2/docs/build/plugins/cli/).

## Important semantic details

### Background execution and completion

The native `subagent` handler checks agent mode, ancestry, delegation permissions, and child ownership. It returns the child session ID, which native jobs also use as their identity. Direct `session.create` does not reproduce those checks. A wrapper can obtain callable native tool definitions via `ctx.tool.list`, but directly calling their executor omits the normal outer tool admission, schema validation, and hooks. This requires a real invocation context, explicit validation, and an integration test. [Pinned native handler](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/tool/plugin/subagent.ts).

The default `experimental.subagent_depth` is one; the proposed supervisor hierarchy needs at least two. Native subagent input has no caller-selected prompt ID. Capture actual child admission IDs instead of claiming deterministic native prompt IDs. [Pinned native handler](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/tool/plugin/subagent.ts).

Prompt and synthetic-message operations return admitted inbox entries. Track `session.execution.started/succeeded/failed/interrupted`, then validate the recorded outcome. These events represent a busy execution period; `session.step.ended` may precede more work. [Execution source](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/session/execution.ts), [session schema](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/schema/src/session.ts).

### Permissions and location

Child sessions inherit location, metadata, and session permission rules. Explicit child permissions replace the inherited snapshot. When `parentID` is set, creation chooses the parent's location, even if an explicit location is supplied. [Session creation](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session.ts).

Effective permission rules put session rules after selected-agent rules; the last match wins. Inherited broad session allows can therefore defeat a read-only role's own deny rules. Native delegation does not automatically compute our desired intersection of parent role, run, and worker restrictions. Compile and enforce that policy before execution. [Permission implementation](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/permission.ts).

The native tool creates a child, then awaits its progress callback before prompting it. A wrapper retaining the actual invocation context can intercept that callback to bind the child and install restrictions before returning. Worktree placement can move the still-unprompted child and wait for preparation to settle. This depends on source ordering rather than a documented prelaunch API and must pass failure/race tests. Movement can create preparation execution events, which are distinct from the task's execution. [Pinned subagent ordering](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/tool/plugin/subagent.ts), [session move contract](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/protocol/src/groups/session.ts).

For checks, the native `shell` tool performs command permissions and external-directory authorization. Its structured outcome includes exit/signal/timeout/output information. Calling a plugin's own process runner or a manual-user shell endpoint does not establish equivalent checks. [Native shell source](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/tool/plugin/shell.ts).

### Persistence and recovery

Native restart logic resumes top-level claimed executions and native recoverable background jobs. Ordinary API-created children are not equivalent recovery entries. Native notification IDs support idempotent inbox admission. Shell jobs interrupted by a server restart are cancelled. These mechanisms do not establish exactly-once side effects. [Pinned restart source](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/execution/restart.ts).

The inspected 2.0.26 change moves native subagent completion observers to a global service that outlives the launching plugin. In 2.0.25 they are constructed in plugin scope. This makes plugin reload a version-sensitive integration test. [2.0.25 job helper](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/subagent-job.ts), [2.0.26 job helper](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/session/subagent-job.ts).

Native completion submits a synthetic message without specifying delivery, which defaults to `steer`. The real-host probe confirms that this does not abort an executing tool: admission happens during the tool and delivery at its subsequent step boundary. Ultra can queue its own reports, but that does not change the native supervisor's parent notification; strictly idle-only completion would require a supported configurable delivery boundary. [Pinned completion source](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/subagent-completion.ts), [synthetic admission source](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/session.ts).

### Documentation discrepancies

At inspection time, overview examples show `ctx.permission.rules` and interruption with `continue: false`. Both inspected source versions instead expose permission replacement through `session.update` and an interruption field named `resume`. Compile against pinned types and validate with the real host. [Overview examples](https://dev.opencode.ai/v2/docs/build/plugins/), [pinned permission type](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/permission.ts), [pinned session protocol](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/protocol/src/groups/session.ts).

## What remains to prove

The [compatibility spike](compatibility-spike.md) now demonstrates the execution bridge, first-prompt restrictions, nested/concurrent workers, completion correlation, cancellation settlement, driver support, native service recovery, and notification behavior on the installed host. CLI historical event replay is unavailable; use native snapshots plus our observed event history. Full policy compilation, in-flight reload recovery, native delegated-child worktree preparation, and automatic mode remain subsequent work.

Publish exact tested versions and capabilities when those checks pass. A minimum compatible version cannot be asserted from documentation alone.
