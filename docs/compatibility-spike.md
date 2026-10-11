# OpenCode 2 compatibility spike

Tested on 2026-10-11 against the installed `@opencode/cli` **2.0.25**, on Windows. Matching `@opencode/plugin` and `@opencode/client` packages are pinned in the lockfile. The host reports bundled Bun **1.4.2**; the test harness uses Bun **1.3.10**.

Result: **22 real-host probes passed, one capability is unavailable in this CLI profile, and eight fixture/isolation unit tests passed.** TypeScript checking passed. These tests establish host integration behavior, not model quality or Claude parity.

The [machine-readable result summary](compatibility-spike-results.json) identifies the recorded run, individual outcomes, and its full local evidence file.

The production v1 workflow now builds on these contracts. Its separate native integration suite exercises the real plugin, saved plans, scoped workers, evidence, cancellation, restart, automatic invocation, and unavailable-model rejection. See the [implementation checkpoint](design.md#14-implementation-checkpoint-and-remaining-validation) and [installation guide](../README.md). The original spike evidence below remains a record of host primitives rather than a claim that every optional production extension is enabled.

The API source reference is [b44eea9e204024db2b480a136ece29d790d5f593](https://github.com/anomalyco/opencode/commit/b44eea9e204024db2b480a136ece29d790d5f593). The executable's version is verified through its manifest and server response; its build commit is not independently verified.

## Reproduce

From the repository root:

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
bun run spike
```

Requires Bun, Git, and OpenCode 2.0.25. `OPENCODE_SPIKE_BIN` can specify the executable. The runner checks the host version and the plugin rejects other versions.

The harness starts `opencode serve --service` on a free loopback port with a random local password. It redirects configuration, homes, caches, logs, temporary files, provider catalog, and the host database into a fresh `.spike/run-<timestamp>/` fixture. Child processes receive an environment allowlist. The only configured model provider is a local OpenAI-compatible HTTP fixture; no user credentials are forwarded.

`report.json` records each check's outcome and evidence, plus sanitized model requests. `host.log` records process output. Each activated project/location contains `.ultra-spike/compatibility.sqlite`, storing observed events and bindings. Configuration and dirty worktree fixtures remain available for inspection. The host and fixture endpoint stop in `finally`.

Exit code is nonzero for a failed assertion. An explicitly identified unsupported capability remains visible in the report and does not turn supported probes into failures.

## Capability matrix

| Capability | Result | What the running host demonstrated |
| --- | --- | --- |
| Plugin and RPC registration | Pass | Official `Plugin.define`, commands, tools, RPC, host version, and `bun:sqlite` work. |
| Deterministic commands | Pass | `/ultra-spike status` records a command without a model request. |
| Real tool context | Pass | Native session/message/call identity, progress, and `AbortSignal` reach a custom tool; its durable tool state is completed. |
| Model selection | Pass | A session and delegated child use the selected `fixture/alternate` model. |
| Background delegation | Pass | Registered native `subagent` returns a running child handle while that child's model request remains held. |
| Prelaunch restrictions | Pass | Child policy is installed and verified before its first model request. |
| Concurrent children | Pass | Two children run concurrently with distinct call IDs and bindings to the correct parent. |
| Permission wait | Pass | Native shell assertion asks; the command does not execute before a fixture reply. |
| Permission rejection | Pass | Rejecting the request prevents native execution and yields a durable tool error. |
| Read-only worker | Pass | A direct native shell attempt to mutate a fixture file is denied; the file remains unchanged. |
| Supervisor → worker | Pass | Native ancestry at depth two works with `subagent_depth: 2`; worker session rules deny further delegation. |
| Invalid model | Pass | Native dispatch rejects an unavailable model before child creation, without fallback. |
| Queued input | Pass | A queued prompt is delivered without aborting the running tool. |
| Native completion | Pass | One correlated synthetic notification is admitted during the parent tool, then delivered after that tool finishes. |
| Tool cancellation | Pass | Interruption reaches the actual tool signal; the tool acknowledges it and the session settles as interrupted. |
| Child cancellation | Pass | The same interruption/settlement behavior holds for a native background child. |
| Failed preparation | Pass | Prelaunch rejection leaves a recorded, unprompted child; no child model request occurs, and cleanup waits for idle. |
| Native verification | Pass | Registered native shell returns completed status, exit 0, output, metadata, and a completed outer tool record. |
| Ownership and filtering | Pass | Foreign projects and another location of the same project are excluded from the source observer; healthy RPC controls distinguish ownership rejection from a missing plugin. |
| Duplicate events | Pass | Replaying an already-recorded host event ID cannot insert another row. |
| Plugin reload | Pass | Idle reload closes registrations and reopens the database without duplicate commands or tools. |
| Service restart | Pass | A held native background child resumes on the same session ID, then succeeds; only one launch was recorded. |
| State persistence | Pass | Adapter SQLite history and native session/tool snapshots survive another process restart. |
| Native historical events | **Unavailable** | `session.log` returns a synchronization marker without historical session payloads in this CLI profile. |
| Worktrees | Pass | Native create/list/refresh, shared project identity, inherited child placement, explicit move, isolated modifications, event exclusion, and refusal to remove a dirty worktree work. |

Several rows share one probe; the runner contains 23 probes total.

## Integration decisions from the spike

**Activate before inspecting.** Location inventories can initially return empty lists. Prompt preparation activates plugins; the worktree probe uses `resume: false` and makes no model calls. Inventory alone is not an initial capability check.

**Declare input and output schemas.** A custom executor can run successfully and still produce an outer tool error if it returns structured output without an output schema. Assertions check durable tool states as well as adapter lifecycle events.

**Permission metadata is not admission.** `Tool.options.permission` controls visibility of wholly denied tools; it does not perform a generic permission assertion. The spike invokes the registered native shell or subagent with a genuine tool context, allowing their internal assertions to run. Native input is explicitly decoded using the registered schema. Nested calls are recorded because calling an executor directly skips the outer nested admission/hooks. [Pinned native subagent](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/tool/plugin/subagent.ts).

**Narrow inherited session policy before prompting.** Broad parent session allows can override a worker agent's own deny rules. The bridge appends worker restrictions to the inherited snapshot, preserves ordered permission semantics, and verifies persistence inside the native progress callback before releasing preparation. This spike proves the fixture restrictions. The production engine now adds a run/role/scope intersection, with a regression test that retains an ordered allow exception following a broad captured deny.

**Steer is a step-boundary operation.** Native completion uses `steer`, but does not abort an executing tool. The probe records admission before tool completion and delivery afterward. Queued delivery still differs: it waits for idle. Native completion delivery is not configurable through the inspected subagent input, so Ultra's queued reports cannot change that native behavior.

**Use snapshots and our own history for recovery.** The native CLI bus does not persist historical event payloads in the tested profile. No supported CLI/config/environment switch was found to enable them. Embedded server options expose `events.persist`, which requires a separate compatibility profile. Persist observed events in our database, and reconcile native session, tool, and permission snapshots after reconnect. Missing events must be marked as gaps rather than reconstructed as exact history. [Pinned bus](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/core/src/bus.ts), [CLI server startup](https://github.com/anomalyco/opencode/blob/b44eea9e204024db2b480a136ece29d790d5f593/packages/cli/src/server-process.ts).

**Match recovery requests by task identity.** OpenCode adds a restart notice to the child's history. The resumed provider request is matched by both its original child task and the restart notice; a parent merely mentioning the child task in tool arguments cannot satisfy the recovery assertion.

## Spike limits and subsequent implementation

The spike is a diagnostic plugin, not the workflow engine. It does not implement task graph scheduling, leases, graph revisions, role/stage configuration, budgets, command intents, artifact acceptance, or a notification outbox.

Only Windows/OpenCode 2.0.25 is tested. Other versions, operating systems, real providers, model variants, and TUI installation remain unverified. The prelaunch callback ordering is version-sensitive and needs a fail-closed compatibility gate. Idle plugin reload is proven; in-flight reload and observer continuity remain unproven. Restart recovery uses `--service`, a held text-generation request, and the same native child; it does not establish exactly-once external effects or recovery for ordinary `serve`.

Worktree placement uses an API-created fixture child and verifies native move semantics. Moving a native delegated child inside its prelaunch callback, then binding its first task prompt and destination policy, remains a separate test before parallel writers are enabled. Worktree/permission checks are not an operating-system filesystem sandbox.

The spike originally handed off to the read-only vertical slice. That slice and full execution with one writer are now implemented in the production plugin, including durable run/task/attempt state, model resolution, command intents, the native supervisor bridge, snapshot reconciliation, lifecycle controls, budgets, repair, and exports. See the [dated implementation checkpoint](design.md#14-implementation-checkpoint-and-remaining-validation) for the separate production test results and remaining extensions. Historical event replay from the CLI remains unavailable.
