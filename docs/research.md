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

The later **2.0.26** check uses an isolated official `@opencode/cli-windows-x64` package and source reference [d21b0790a6c146815f28fea604e41e922f009590](https://github.com/anomalyco/opencode/commit/d21b0790a6c146815f28fea604e41e922f009590). Its native server reports 2.0.26; the package metadata does not attest a build commit. This supersedes the earlier development-source-only finding. See the [compatibility extension](compatibility-spike.md#opencode-2026-extension).

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

## Plugin and terminal API review — 11 October 2026

This review uses the installed `@opencode/plugin` and `@opencode/client` **2.0.25** declarations and README, the pinned host implementation above, current versioned documentation, and native CLI help in an isolated profile. It does not extend the supported host range or establish desktop UI extension support.

The server implementation is idiomatic in its use of `Plugin.define`, command and tool registration/transforms, permission hooks, native session operations, RPC, and live event subscription. The installed SDK explicitly requires `effect` as a peer dependency and development dependency. The host supplies the shared Effect runtime; bundling a private copy or importing private Effect modules is unsupported. The matching installed version is `4.0.0-rc.112`.

The execution adapter calls the native tool's exposed executor with a real invocation context. The native handler still performs its permission checks, but the surrounding normal tool admission and `execute.before`/`execute.after` hooks are bypassed. Other plugins depending on those hooks may not observe nested Ultra calls. The public tool domain has no general invocation method; the public agent editor has no add operation. Source-verified prelaunch ordering remains necessary to restrict children before their first prompt. Preserve the compatibility gate; a supported upstream tool invocation and prelaunch contract would remove this fragility.

### Supported native terminal integration

The terminal SDK supplies command-palette registration through `keymap.layer`, dialog selection/prompt/custom rendering, plugin route registration, and `session.panel`/sidebar extension slots. It exposes current model/variant selection, catalogue data, and typed RPC clients. A package `./tui` export is loaded alongside its configured server plugin; a second `cli.json` plugin registration is unnecessary. These are suitable for an **Ultra settings** dialog and a live workflow panel. [Terminal extension API](https://dev.opencode.ai/v2/docs/build/plugins/cli/), [CLI plugin loading](https://opencode.ai/v2/docs/cli/plugins).

No settings contribution API or settings slot appears in the inspected complete context/UI/slot declarations. OpenCode's **Open settings** action edits `cli.json`, which controls the CLI separately from server `opencode.json`; unknown CLI settings are rejected. Accordingly, do not put Ultra options into that file or replace an internal settings component. Provide a plugin-owned dialog or route from the palette. Native desktop settings integration remains unverified. [CLI configuration](https://opencode.ai/v2/docs/cli/config).

RPC events are live and are not a persistent replay source. A UI client should refresh the engine's durable snapshot after subscribing or reconnecting, then apply events by revision. Server-side settings writes must validate ownership and source revisions, preserve unrelated native configuration, and keep an active run's captured options immutable. [RPC contract](https://opencode.ai/v2/docs/build/plugins/rpc/).

The native plugin manager exposes add/list/check/update/remove and accepts npm or Git sources. The isolated `opencode plugin add --help` confirms those source forms in the installed executable. Native package installation is a good distribution direction, but does not alone establish the reserved supervisor/worker agents or required delegation depth. Retain explicit setup until a supported and tested bootstrap can replace it. [Native plugin management](https://opencode.ai/v2/docs/plugins).

### Model-facing review

The initial `ultra_submit` input used `Schema.Unknown` for its nested result and described its shape only in prompt text. Engine checks did not validate every nested value: non-string finding evidence could be persisted and crash later reconciliation, while malformed finding/assessment arrays produced incidental errors. A schema shared by the tool definition and strict engine parser gives models a discoverable structural contract and makes invalid submissions correctable before persistence. Prompt examples should use the task's actual criterion IDs and state which stages require assessments.

The initial repair path assigned `ownedPaths: ["**"]` even when the accepted execution writers had narrower scopes. Repair should preserve the accepted scope union, and a graph without a writer should end partial instead of acquiring write authority. Provider identity is not needed for either correction.

Other reviewed limitations are still proposals: aggregate context budgeting and dependency-result retrieval, early review/check coverage validation, lazy project state creation, and observer reconnect with explicit gaps. The [maintained design](design.md#15-plugin-model-contract-and-native-ux-review) records their independent states. Local scripted-provider tests demonstrate the execution contract rather than actual model quality.

### Terminal command feedback correction

The reported blank `/ultracode config` output exposed an incorrect use of synthetic input. In 2.0.25, `session.synthetic({ delivery: "queue", resume: false })` admits future model input; it does not display a command result. The terminal's pending-input list filters synthetic entries. The server command executor returns no displayable value and exposes no output callback. Command results now use a typed live RPC event, which the package's `./tui` companion renders in native dialogs. `/ultracode config` is the sole terminal configuration entry point; the initially added palette action and `/ultra-config` shortcut were removed at the user's request. The server's configuration RPC remains available to other clients. [Command contract](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/plugin/src/promise/command.ts), [synthetic admission](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/session/session.ts), [terminal prompt](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/tui/src/component/prompt/index.tsx).

The existing `/ultracode` command remains native server dispatch. A local slash handler with arguments runs before the composer commits its chosen model and agent; intercepting it would capture the previous selection when starting a workflow. The removed local action used a global keymap layer because default base layers are hidden from reachable command discovery while autocomplete and palette dialogs activate their own input modes. This remains an API finding, not a current command registration. [Keymap discovery](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/tui/src/context/keymap.tsx#L321-L349), [autocomplete mode](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/tui/src/component/prompt/autocomplete.tsx#L96-L100).

## OpenChamber settings integration — 11 October 2026

Inspected OpenChamber's development source at [cbbe09f20fd8562f8ef7b56b92a1258011b61d7d](https://github.com/openchamber/openchamber/commit/cbbe09f20fd8562f8ef7b56b92a1258011b61d7d), whose package still declares version 2.2.0. Its existing Plugins settings page displays explicit native plugin options as JSON and updates the selected entry on blur. Its backend reads `{ package, options }` entries from user and project configuration, then writes the same source entry while preserving unrelated native configuration. A local package is labelled by its directory path. This is an existing OpenChamber feature; Ultra does not need a private UI hook or another settings service. [Settings page](https://github.com/openchamber/openchamber/blob/cbbe09f20fd8562f8ef7b56b92a1258011b61d7d/packages/ui/src/components/sections/plugins/PluginsPage.tsx), [plugin settings reader/writer](https://github.com/openchamber/openchamber/blob/cbbe09f20fd8562f8ef7b56b92a1258011b61d7d/packages/web/server/lib/opencode/plugins.js).

Without a parent `OPENCODE_CONFIG`, the editor reads the global directory. An explicit parent custom profile becomes its user source instead. OpenChamber's managed-config builder returns additional child environment values without mutating the parent; its generated child file therefore does not hide the parent's global Ultra entry. The integration probe checks that production builder and editor together, but does not launch the complete OpenChamber application. [Managed configuration](https://github.com/openchamber/openchamber/blob/cbbe09f20fd8562f8ef7b56b92a1258011b61d7d/packages/web/server/lib/opencode/managed-config-file.js).

The editor validates that options are a JSON object; Ultra validates their actual fields when activated. It shows stored options rather than Ultra's resolved defaults or `ultracode.json` overlay. A same-package native project entry replaces global native options; Ultra's standalone project file still merges named fields over that result. Dedicated model pickers and inheritance controls inside OpenChamber's Plugins settings page would require an OpenChamber UI change. Its separate extension SDK provides panels, pages, and account integration fields, but no contribution point for arbitrary forms in that plugin-options editor.

The released OpenChamber 2.2.0 desktop package pins OpenCode 2.0.25; the inspected development revision pins 2.0.26. That later host retains the native child-create → awaited progress → prompt ordering, with completion tracking moved to a global job service. The official plugin declarations and implementations, and client declarations, are unchanged between the inspected 2.0.25 and 2.0.26 packages; Effect remains `4.0.0-rc.112`. Existing pinned SDK imports can therefore be checked against both native hosts without introducing a client-specific execution path. [Released dependency](https://github.com/openchamber/openchamber/blob/v2.2.0/packages/electron/package.json), [development dependency](https://github.com/openchamber/openchamber/blob/cbbe09f20fd8562f8ef7b56b92a1258011b61d7d/packages/electron/package.json), [2.0.26 native subagent](https://github.com/anomalyco/opencode/blob/d21b0790a6c146815f28fea604e41e922f009590/packages/core/src/tool/plugin/subagent.ts). Runtime and settings read/write results are recorded in [CLIENT-SETTINGS](design.md#change-client-settings--single-command-and-openchamber-configuration).

Released tag `v2.2.0` resolves to `74b79d41eac44ff38790c66f238050936083e0bb`. Its Plugins page, grid, store, and autosave source match the inspected development revision, and all plugin-setting English labels match. Seven imported server helpers also match; the managed-config module's only relevant comparison difference concerns an unrelated agent-control option. The released production helpers passed the same six-check settings probe on native 2.0.25. A complete graphical application launch remains unverified. [Released settings page](https://github.com/openchamber/openchamber/blob/74b79d41eac44ff38790c66f238050936083e0bb/packages/ui/src/components/sections/plugins/PluginsPage.tsx).

The host's JSON Schema importer supports only a subset of the specification. A first native test rejected the feedback schema's `not` keyword. The supported `oneOf` branches with required `result` or `error` retain mutual exclusion without `not`. Regression tests compile through the actual installed importer and reject missing or conflicting outcomes. The [delivery record](design.md#change-command-feedback--visible-terminal-results-and-configuration) distinguishes server-event checks from actual terminal rendering.
