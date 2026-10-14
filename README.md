# Ultra Open Code

An independent, transparent implementation of thorough multi-agent workflows for OpenCode 2.

OpenCode is the compatibility target. Other clients, including OpenChamber, use the same native agents, tools, sessions, permissions, and plugin configuration.

The v1 runtime supports task-specific discovery, design, critique, implementation, review, native verification, bounded repair, and evidence-backed reporting. Ultra selects the smallest useful task graph; a persistent engine controls asynchronous native agents while the initiating conversation stays available.

Prompts, graph revisions, model selections, native session bindings, attempts, observed context, tool activity, checks, and recovery decisions are inspectable. Model assessments and actual command evidence remain separate.

## Install globally

Requires Bun **1.3.10 or newer** and OpenCode **2.0.25, 2.0.26 or 2.0.28**, either a CLI installation or an explicitly selected bundled executable. Only these exact host versions are accepted. Native 2.0.28 compatibility, production integration and isolated parallel workflows are verified on macOS; earlier Windows verification remains recorded in the design history. Git is optional for normal workflows.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run install:global
```

Run these commands from this checkout, then restart OpenCode. The plugin becomes available in each project without another installation. The installer registers this local package in the global `opencode.json` or `opencode.jsonc`, adds the selectable `ultra` primary agent and dedicated `ultra-supervisor` and `ultra-worker` agents, and sets native delegation depth to at least two. It preserves existing providers, models, and permission settings and saves the original configuration when changed. JSONC is rewritten as formatted JSON; the backup retains comments. Repeating an unchanged installation creates no extra registrations or backups. Keep this checkout available at its installed path. Existing installations should run the installer again to add the new primary agent.

The global directory is `OPENCODE_CONFIG_DIR` when set, otherwise `XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when XDG is unset. These are OpenCode 2.0.25's paths on Windows too. To select another global directory, use `--config-dir`; OpenCode must use the same directory through `OPENCODE_CONFIG_DIR`.

If you use only OpenChamber's bundled OpenCode, select its actual executable before installing. The following path is a placeholder; use your OpenChamber installation's `resources/opencode-cli/opencode.exe`:

```powershell
$env:OPENCODE_BIN = "C:\path\to\OpenChamber\resources\opencode-cli\opencode.exe"
bun run install:global
```

The installer recognises official CLI and matching native package manifests. For an explicitly selected bare executable, it checks `--version` in a temporary isolated profile. An invalid explicit selection fails instead of using a separate installed CLI. OpenCode also checks its live host version when loading the plugin.

An optional standalone project installation remains available:

```powershell
bun run install:project --project "C:\path\to\your-project"
```

For a globally installed plugin, use the project override file described below. An existing project registration targeting the same plugin replaces its global native options under OpenCode's rules. To inherit global defaults, move that registration's `options` into `ultracode.json` and remove only its Ultra entry from the project's `plugins` array, preserving other plugins and native settings. Different package references for the same plugin can create duplicate IDs; use the single global registration.

Select a connected model, choose **Ultra** beside **Build** and **Plan**, and describe your task normally:

```text
Plan resumable uploads for this API. Stop at a proposal.
Implement the agreed upload changes and tests.
Show the effective Ultra settings.
What is the current workflow status?
Pause the current workflow.
```

Ultra uses the existing graph engine through native `ultra_task` and `ultra_control` tools. General questions, configuration inspection, and clarification remain conversation; they do not automatically admit a graph based on prompt length. Planning saves a read-only proposal. Implementation requests authorise design and execution within their scope, under native permissions. Role and stage model settings continue to apply.

Agent use adapts to the request. Simple explanations and lookups can use read tools without workers. A focused design can use one planning worker. When Ultra has enough context for a small implementation, it supplies a scoped writer, independent reviewer and configured verifier directly, skipping a planning team. Larger tasks can add useful specialists and dependencies. Research, critique, reconciliation and reporting workers are optional. The model chooses the graph through a typed `workflow: { rationale, tasks }` field; there is no keyword complexity classifier or extra routing model. The engine preserves the request and check criteria and rejects unsafe graphs before dispatch. Omitted graphs, including legacy command starts, begin with one combined planner.

Ultra's replies explain concrete code findings, design decisions, behavior changes, and test evidence. Starting a task supplies its objective and bounded task purposes, so the opening can explain the intended investigation or changes. Background completion brings results back to the conversation; the guidance avoids repeated status polling. Completed work supplies accepted technical summaries rather than only task counts and file paths. Detailed scheduling information remains available through inspection when needed. The exact older bundled primary prompt upgrades when a model request is assembled; custom prompts remain intact. Rerunning the installer persists the new default in native configuration.

Progress and results use normal native tool and subagent activity. Follow-up controls stay bound to their initiating conversation; repeated calls cannot launch the same intent twice. Selecting Build or Plan does not cancel a workflow. The initiating conversation retains coordinator restrictions while its run is active, including while paused; cancel or finish that run before direct project edits there. Other conversations retain their normal agent behaviour. The model selects tools from clear schemas; actual model quality and instruction following require separate evaluation.

Each worker has a saved native child-session identity. Recovery reconciles those sessions before continuing; an unknown launch or session outcome requires inspection rather than another dispatch. A returning bound supervisor can continue its existing attempts after interruption. In OpenCode's terminal, open **Subagents** with Down from the empty composer. The native panel shows the supervisor and its nested workers, including after reopening the conversation. It defaults to running agents; **Ctrl+A** switches to inactive agents and back. An empty active panel does not establish whether a launch failed or the work already finished. Restart the terminal after updating this checkout to load the companion fix. Other native clients use their own session presentation; OpenChamber exposes workers inside the supervisor's conversation.

Conversational inspection returns a compact, redacted view of actual task attempts and native checks. It keeps valid JSON below 30,000 bytes, prioritizes accepted and recent evidence, reports omitted records, and includes bounded log previews and engine failure reasons. Whole-run summaries use accepted, native-succeeded results at the saved candidate and include a ready plan's exact proposal revision. Ask for a specific task's evidence to inspect historical results; RPC inspection and exported audits retain the full redacted history.

The native command interface remains available for explicit controls:

```text
/ultracode plan Add resumable uploads to the API
/ultracode inspect <run-id>
/ultracode run <run-id>@<saved-revision>

/ultracode start Implement the agreed upload changes and tests
/ultracode status
```

`plan` stops at a saved proposal. `run` executes an exact saved revision after checking workspace freshness. `start` authorises design and implementation within the requested scope. Native permission requests still apply.

## Commands

| Command | Purpose |
| --- | --- |
| `start <task>` / `-- <task>` | Design and execute a workflow. |
| `plan <task>` | Read-only discovery, design, critique, and saved proposal. |
| `run <id>@<revision>` | Execute a fresh saved proposal. |
| `status [id]` | List runs or show progress. |
| `inspect <id> [task-id]` | Inspect saved state, attempts, prompts, models, and events. |
| `pause <id>` / `resume <id>` | Drain active work, or reconcile and continue it. |
| `cancel <id>` | Interrupt agents; retain partial work and history. |
| `retry <id> <task-id>` | Retry an eligible settled failed task with a new attempt. |
| `input <id> <answer>` | Answer a recorded worker question and refresh affected tasks. |
| `budget <id> <limits-json>` | Explicitly increase limits for a paused or budget-blocked run. |
| `export <id>` | Write JSON, Markdown, and a read-only HTML dashboard. |
| `config` | Show effective settings and the supported host version. |
| `on` / `off` | Persistently enable or disable automatic mode in this session. |

Prefix every command with `/ultracode`. IDs can be shortened when unambiguous. Mutating controls must come from the run's initiating conversation and location; workers cannot issue them. Status, inspection, configuration, and other control handlers do not need a model call, although starting or continuing work admits native model execution.

The older automatic command mode remains explicit opt-in for other primary agents. After `on`, ordinary prompts of at least `autoThreshold` characters (default **80**) start an execution workflow when the session has no active run. Ultra mode always interprets requests through its tools, regardless of that opt-in or threshold. `off` affects future automatic prompts; cancelling an existing run is separate.

```text
/ultracode input <run-id> Use the existing API rather than adding a new endpoint.
/ultracode budget <run-id> {"attempts":36,"runMs":3600000}
/ultracode resume <run-id>
```

## Read-only recipes and live progress

Explicit recipes reuse the same graph engine, model settings and permissions:

| Recipe | Work |
| --- | --- |
| `deep-review` | Independent behavior and failure/security reviews, followed by evidence-based reconciliation. |
| `bug-investigation` | Trace the failing path and alternative causes, then explain the root cause and regression strategy. |
| `cross-checked-research` | Independently establish the primary contract and counterexamples, then reconcile versions, citations and uncertainty. |

```text
/ultracode plan --recipe deep-review Review the retry handling
/ultracode plan --recipe bug-investigation Explain the timeout regression
/ultracode plan --recipe cross-checked-research Compare the supported API versions
```

In Ultra mode, explicitly ask for the named recipe, or use `ultra_task` with `mode: "plan"` and `recipe`. Recipes cannot be combined with an authored `workflow` or execute mode. A completed report can reach `ready` without manufacturing an implementation proposal; unresolved blocking findings remain `partial`. A justified worker-authored corrective proposal still requires explicit exact-revision execution. Preview a recipe offline with `bun run ultra render --recipe deep-review "Review the public API"`.

In the OpenCode terminal, `/ultracode status [id]` opens a live searchable workflow dialog. It shows task/model/session identities, dependency and permission waits, accepted results, unresolved findings, native evidence, and observed worker usage. Pause, Resume and Cancel operate through the existing initiating-session ownership checks. Open agent session navigates to the selected native worker. Snapshots refresh every two seconds only while the dialog is open, and immediately after controls or reconnect. Historical checks and repaired findings cannot masquerade as current final evidence. Unknown or partially observed usage is labelled explicitly; worker totals exclude unobserved supervisor and auxiliary costs. OpenChamber still lacks the RPC bridge needed to display this native terminal viewer.

## Models, checks, and prompts

By default, every role inherits the initiating session's captured model and variant. To configure shared defaults, create a JSON file and pass it to the global installer:

```powershell
bun run install:global --config "C:\path\to\ultra-options.json"
```

Example options; replace the model references with entries from your connected OpenCode catalogue:

```json
{
  "models": {
    "default": "inherit",
    "roles": {
      "planner": "provider/design-model#variant",
      "implementer": "provider/coding-model",
      "reviewer": "other-provider/review-model"
    },
    "stages": {
      "reporting": "provider/reporting-model"
    }
  },
  "checks": [
    {"id": "tests", "command": "bun run test", "criterionIds": ["verification"], "timeoutMs": 120000},
    {"id": "types", "command": "bun run typecheck", "criterionIds": ["verification"], "timeoutMs": 120000}
  ],
  "prompts": {
    "reviewer": "Focus on backwards compatibility and failure behaviour."
  }
}
```

To override selected defaults for one project, add an optional `ultracode.json` in the directory where OpenCode runs:

```json
{
  "models": { "roles": { "reviewer": "other-provider/project-review-model" } },
  "limits": { "workers": 2 },
  "prompts": { "reviewer": "Check this project's public API compatibility." }
}
```

The plugin merges OpenCode's effective native plugin options with this file, then supplies built-in defaults. Models by role or stage, limits, and prompts merge field by field. Scalars replace inherited values; `checks` replaces the entire inherited array, including an explicit `[]`. Each layer is validated independently. No override file or project installation is required. The plugin reads only the exact session directory's `ultracode.json`; it does not search parent directories. Restart OpenCode after editing it. New runs capture the resulting configuration; existing runs retain their saved settings.

Use `/ultracode config` to open **Ultra settings**. The first screen offers **This project**, **Global defaults**, **Help**, and **About Ultra**. Choose a scope, then **Models**, **Limits**, **Checks** or **Advanced configuration**. Editable values appear only in their editable section; there is no separate read-only list of the same limits or models. Restart the terminal client after updating this checkout so it loads the package's `tui.ts` companion. Other Ultra command results and errors also appear in native dialogs for their initiating session.

**This project** changes this location; **Global defaults** changes defaults for projects using the server's OpenCode profile. Project overrides take precedence. The chosen scope stays visible inside each section. **Models** selects a default, role or stage mapping from connected models with tool support, including variants. Reset removes an override; **Follow the initiating chat model** explicitly stores `inherit`. Stage mappings take precedence over role mappings. Each section stays open while you make multiple changes; **Back to settings** or Escape returns to the scoped menu.

**Limits** shows current values and their source. Select a limit to edit it directly; the list stays open for multiple edits. Deadlines use seconds, including fractional seconds to millisecond precision. Press **Ctrl+R** on a limit to restore its inherited value, or its built-in default when editing globally. The numeric prompt also accepts `inherit` for project values or `default` for global values. Invalid input stays available for correction. **Checks** adds, edits or removes verification commands, criterion IDs and optional timeouts. Project check lists replace the inherited list. Resetting global checks restores discovery in each project unless overridden. An explicit empty list disables configured checks and prevents verified execution success.

Changes stay in a draft until the scoped **Save** action shows the target file, exact changes and impact, and you confirm. **Change scope** returns to the scope chooser; leaving a changed draft requires explicit discard. Navigation or reconnect retires the editor. Existing files are backed up, stale revisions are rejected, and saving requires settled workflows.

Project saves write this location's `ultracode.json`, preserve other options, and apply to new workflows immediately. Global saves update only Ultra's editable options in the active native `opencode.json` or `opencode.jsonc`, preserving comments, credentials, other plugins and unrelated options. The server uses `OPENCODE_CONFIG` when set, otherwise its configured global directory. A unique direct Ultra registration is required; ambiguous or symlinked profiles are refused. Global saves require an OpenCode reload to apply across projects. Existing runs keep captured settings; configuration changes can invalidate saved plan fingerprints. Backups live under `.ultracode/settings-backups/` beside the native profile for global saves, or in the project's runtime directory for project saves.

**Help** offers short guides to **Scopes & inheritance**, **Editing & saving**, **Advanced controls**, and **Workflow commands**. Closing a guide returns to the same topic; Back or Escape returns to settings. **About Ultra** opens directly from settings and shows Ultra's purpose, versions, project directory and state location.

**Advanced configuration** edits role instructions, writer policy and the automatic-mode threshold inside either scope. Role text supports multiple lines and supplements built-in guidance. Use **Ctrl+R** on a role, or submit blank text, to restore inherited/built-in instructions. Writer policy offers serial writers or isolated parallel writers; parallel writing requires a clean committed Git root and native Git permissions. The threshold sets the minimum prompt length for the existing per-conversation automatic mode after `/ultracode on`; changing it does not enable that mode or change Ultra mode. Enter `inherit` (project) or `default` (global) in the threshold prompt to restore its inherited/default value. Every edit joins the same draft and confirmed save; JSON editing is optional. Settings operations make no model calls. OpenCode's built-in **Open settings** action edits CLI appearance and interaction settings in `cli.json`. OpenChamber can edit standard plugin options as described below; the guided editor uses the native OpenCode terminal companion.

Model selection order is authorised task override, run stage, run role, effective project stage, effective project role, run default, effective project default, then inheritance. Effective project mappings include inherited global defaults. Model and variant resolve together. Missing models, invalid variants, and known lack of tool support are rejected without fallback. Each attempt saves its resolved choice and origin.

Versioned task prompts explain the role, scope, criteria, configured checks, and typed submission contract. Generated instructions refer to the objective rather than repeating it; roles that cannot propose execution omit the graph schema and model catalogue. Writers omit assessment fields; other roles choose only existing assessment IDs. Unused input requests should be omitted. Handoffs limit each narrative summary to 6,000 characters, with captured identities and retrieval directions for omitted evidence. The initial task prompt has a default aggregate limit of **64,000 characters**, configurable with `limits.contextChars`. Oversized dependencies become saved-result references; bound workers use paginated `ultra_dependency` reads to retrieve immutable captured results. Model-facing check logs and routine progress are bounded previews; the saved evidence and structured tool outputs retain the existing audit records.

When OpenCode supplies native model limits, Ultra also estimates initial text headroom from the smaller of input capacity and context capacity after an output reserve. It reserves up to 2,048 output tokens and half the remaining input for native instructions, schemas and history, then conservatively treats each allowed byte as a token. This is a UTF-8 byte estimate, not a tokenizer measurement or a guarantee that every later native request fits. Dependency pages and check-log previews also use this headroom. Required instructions, user clarifications and criteria are never clipped. If they cannot fit, dispatch stops in `waiting_budget` before creating a worker attempt. Increase a restrictive manual cap only when the model has headroom; otherwise shorten the request or select a larger-context model. Older models and saved attempts without capacity metadata keep the manual cap.

For local or hosted free models, select a model with tool support and keep every Ultra role and stage on `inherit`. [The local profile](examples/ultracode-local.json) overrides existing role/stage mappings, permits one worker and one run at a time, and uses a 16,000-character manual cap. Merge it into the project's `ultracode.json`, preserve the project's real checks and other settings, and restart OpenCode. Configure native title, summary and compaction agents to use the same local/free model too, so auxiliary host requests do not use a paid default. Set the provider's context/input/output limits to the window actually configured in your inference server, rather than its training maximum. See [OpenCode model configuration](https://dev.opencode.ai/v2/docs/models/).

One planner is the default for investigation. A bounded implementation can use a scoped writer, independent review and assigned checks directly; extra research/reconciliation workers are explicit choices. Fresh role contexts, independent review and actual check evidence can improve consistency, but do not guarantee better answers from every model. Ultra never switches to a paid model when the chosen model is unavailable or a budget is exhausted. Long native histories and source-file reads still consume the host's context and may require native compaction; previews must not be treated as complete inspection.

[The local validation record](docs/design.md#change-local-model-efficiency--smaller-handoffs-and-native-capacity-headroom) reports the reductions and actual outcomes. The 4B model's narrower submissions reduced errors and requests, but its feature candidate still failed the independent boundary oracle. Hosted free access was rejected by the provider. Neither case establishes reliable task completion or guaranteed quality.

For test-first work, proposal workers see the configured check catalogue and can plan a test-writing worker, a verifier recording the expected failure, an implementation worker, and independent final review and verification. Writers edit their owned files; only assigned verifiers execute configured commands. Historical failures remain inspectable, while completion requires evidence against the final workspace. Pending downstream proof makes no assessment claim; an actual failed assessment still prevents success.

When every layer omits `checks`, the plugin detects existing `test`, `typecheck`, and `lint` package scripts and maps them to the `verification` criterion. It uses Bun for a Bun lockfile and npm otherwise. An explicit `checks: []` disables inherited checks and detection. Prefer project-specific commands in `ultracode.json`; shared checks run in each selected project. Use check criterion IDs distinct from the default assessment criterion `request`.

Verifiers execute only configured commands through the native shell tool, under the real worker invocation and native permissions. Exit status, caller identity, command, directory, and candidate hash establish evidence. Execution without a required machine check ends as `partial`; a model saying “tests passed” cannot establish success.

## OpenChamber settings

OpenChamber's **Settings → Plugins** page reads and edits OpenCode's standard plugin entries. Click the card whose name is this checkout's directory path. Its **Installed plugin** detail shows **User config** for the global installation and contains **Options (JSON)**. Edit those options using the same fields shown above: `models`, `limits`, `checks`, `prompts`, and `autoThreshold`. Entries from configuration files are editable; discovered package cards are display-only. Edit the user/global entry for shared defaults, or an existing project entry for project-specific native options. OpenChamber saves the options when the editor loses focus. Use an explicit `{}` to clear that entry's options; leaving the editor blank retains them. It preserves the plugin package path and unrelated native configuration. No separate Ultra extension or custom settings service is required.

If the page says **No plugins yet**, check that the selected configuration profile still contains Ultra in its `plugins` array. Re-run the global installer against that profile to restore a missing registration, then refresh the Plugins page. The installer backs up changed configuration and preserves unrelated settings. Deleting the entry from OpenChamber removes the registration; **Options (JSON)** is where its settings are edited.

Choose **Ultra** in OpenChamber's agent picker and ask for settings, status, or project work in chat. Its normal native tool results use OpenChamber's supported session event path. If OpenChamber's **Auto** model option hides the picker, select an explicit connected model first. Immediate child status shows the supervisor; opening that child conversation exposes its workers. Custom Ultra tools use generic tool cards; this provides basic workflow feedback rather than a live graph dashboard. Configuration inspection through chat involves the selected model; edit settings through **Options (JSON)** above.

OpenChamber 2.2.0 still does not display Ultra's deterministic native slash-command results. `/ultracode` can appear in autocomplete and execute, but the client discards the RPC events used for feedback. `/ultracode config`, status, inspection, and other deterministic command results therefore have no desktop viewer. The terminal companion is loaded only by OpenCode's terminal client. A supported OpenChamber client bridge is [proposed in the design](docs/design.md#change-openchamber-commands--native-command-result-presentation) for model-free command presentation; Ultra mode provides the conversational entry point independently.

The editor shows that entry's explicit options. Ultra's built-in defaults, discovered checks, and `ultracode.json` overrides still apply in the runtime. A native project entry replaces the entire global entry's options; use `ultracode.json` for project overrides that inherit individual global fields. OpenChamber's plugin-options editor does not edit that override file. Save while workflows are settled, and reload OpenCode from OpenChamber to ensure the new settings apply. Saved runs retain their captured settings.

The released OpenChamber 2.2.0 desktop package pins OpenCode 2.0.25; its inspected development revision pins 2.0.26. Those exact hosts remain supported alongside 2.0.28. Install Ultra in the configuration profile used by OpenChamber and OpenCode. If OpenChamber itself is launched with `OPENCODE_CONFIG`, its user plugin editor selects that custom file; otherwise it reads the global configuration directory. OpenChamber's generated child configuration leaves that parent profile intact. Remote settings targeting has not been validated. See the [integration record](docs/design.md#change-client-settings--single-command-and-openchamber-configuration) for tested scope and the remaining proposal for dedicated form controls.

## Persistence and limits

State lives under the canonical project's `.ultracode/`: SQLite state and events, content-addressed artifacts, and run exports. Exclude this directory from version control. Exported reports distinguish current accepted evidence from historical or superseded attempts and identify redactions. The HTML dashboard is a saved snapshot.

Default limits are four workers and two runs per project, 24 worker attempts per run, 24 model steps per worker, two repair rounds, ten minutes per worker, 45 minutes of active run time, and a 24-hour elapsed deadline. Permission waits retain their slots and count towards active worker/run deadlines; pausing stops the run clock once active work settles.

One execution run owns a project at a time. Writers run serially by default; independent read-only tasks can run concurrently. Candidate fingerprints invalidate stale results. Unknown launch or cancellation outcomes retain reservations until native reconciliation establishes settlement. Multiple locations in one OpenCode server share canonical state and coordination; use one server to manage concurrent runs in a project. Independent processes are fenced and queued, with limited throughput rather than distributed scheduling.

Set `"parallelWrites": true` in native options or `ultracode.json` to isolate graphs with at least two independent writers. They require a clean committed canonical Git root without submodules or configured Git filters. A generated preparation worker creates fixed recorded checkouts through native permission-checked Git commands, with repository hooks disabled. This avoids OpenCode's worktree-create startup-command shortcut. Workers move to their recorded locations and receive destination permission hooks before the task prompt. A serial native integration worker applies accepted immutable changes; independent review and configured checks run against the final root. A single-writer graph keeps its normal three-worker path.

The initial parallel mode supports disjoint plain UTF-8 additions and modifications, with a 2 MB captured-text limit per writer. Dependent writing sequences, overlapping paths, deletes, binaries, symlinks, hardlinks, mode changes, and changes omitted by the source manifest are refused; partial worktrees remain inspectable. Retrying or resetting an isolated writer requires a new run. Root freshness is checked before and after native operations; the host's native write primitive does not provide an atomic compare-and-write guarantee against concurrent external edits during permission waits. Keep external edits settled while integrating. Worktrees are never force-removed. Editable native settings, a dedicated graph panel, arbitrary JavaScript builders and mixed-model comparison panels remain future extensions.

The trace covers rendered prompts and supported host observations. It cannot expose private model reasoning or guarantee an exact provider request or complete native event replay: this CLI does not retain native event payload history. Recovery records that gap and reconciles live session snapshots. This implements a similar public workflow pattern to Claude; output quality and feature parity have not been established.

Models submit results through an explicit nested tool schema, with task-specific criterion guidance and a short example. The engine validates submissions before persistence and still checks graph policy and actual native evidence separately. Bounded repair retains the admitted writers' file scope. These contracts are provider-independent; actual model quality needs separate evaluation. The native execution bridge retains permission checks but relies on source ordering and bypasses outer tool hooks, which is why compatibility remains pinned and tested rather than assumed for every OpenCode version or third-party plugin.

## Verification and source map

See [Agent coding architecture](docs/architecture.md) for runtime boundaries, data ownership and extension points, and [Agent coding workflows](docs/agent-workflows.md) for the request lifecycle, graph examples, verification and recovery.

`plugin.ts` assembles the native tools, hooks and lifecycle. `engine.ts` owns run transitions and host calls so every mutation uses the same project lease and generation checks. Shared ownership and pure completion decisions live in separate modules; they do not create another scheduler or storage layer.

| Responsibility | Modules |
| --- | --- |
| OpenCode entry points and native operations | `index.ts`, `tui.ts`, `src/plugin.ts`, `src/opencode.ts`, `src/rpc.ts` |
| Scheduling, controls and recovery | `src/engine.ts` |
| Shared project leases and heartbeat | `src/coordination.ts` |
| Completion criteria, fresh checks and repair decisions | `src/completion.ts` |
| Graph admission, capabilities and scoped writes | `src/graph.ts`, `src/policy.ts` |
| Native model selection and context budgets | `src/config.ts`, `src/context.ts` |
| Guided configuration | `src/settings-menu.ts` for scope/help navigation, `src/settings-ui.ts` for scoped drafts and saving, `src/settings-*-ui.ts` for forms, `src/settings-presentation.ts` for labels and previews |
| Settings validation and persistence | `src/settings-values.ts`, `src/settings-file.ts`, `src/settings.ts`, `src/global-settings.ts`, `src/native-config.ts` |
| Primary guidance, worker handoffs and recipes | `src/agents.ts`, `src/workflow.ts`, `src/recipes.ts` |
| Typed results and captured dependency retrieval | `src/results.ts`, `src/dependencies.ts` |
| Durable state and redaction | `src/store.ts`, `src/redaction.ts` |
| Model-facing controls, inspection and user reports | `src/agent-control.ts`, `src/workflow-view.ts`, `src/artifacts.ts` |
| Workspace fingerprints and isolated Git changes | `src/workspace.ts`, `src/worktrees.ts` |
| Installation and offline tools | `scripts/install.ts`, `scripts/cli.ts` |

Completion decisions consume saved run snapshots without database or host access. Coordination depends on the `Store` interface; SQLite transactions and audit persistence remain in `store.ts`. Redaction is pure shared code used by persistence, reports and model-facing views. The native adapter retains command provenance and permission checks. Persisted state, RPC shapes and existing command entry points stay stable across these module boundaries.

```powershell
bun run typecheck
bun run test
bun run test:integration
bun run test:parallel
```

`test:parallel` uses a private scripted-provider host to exercise permission-checked Git preparation, actual moved native subagents, canonical shared state, exact integration and fresh root verification. It deliberately configures a native startup marker and asserts that the preparation path does not run it. Set `OPENCODE_SPIKE_BIN` to the matching installed host as for the production integration suite.

## Opt-in model evaluations

The evaluation runner attaches to an explicitly selected loopback OpenCode server and creates isolated scratch projects. It covers bug fixes, features, conflicting-source research, read-only planning and interruption after accepted predecessor work. Independent code oracles, file-scope checks and native evidence determine automatic results; the generated Markdown rubric leaves prose quality for human review. Reports retain failed attempts, cleanup failures and unavailable accounting.

```text
bun run test:evaluation --url http://127.0.0.1:4096 --model provider/model#variant --budget '{"attempts":12,"steps":12,"workerMs":60000,"runMs":180000}' --max-cost 1
```

Replace the endpoint/model with your connected host and set your own runtime bounds and observed-cost allowance. All four arguments are required before any connection or model prompt. `--scenario bugfix|feature|research|planning|interrupted` selects one fixture. Model settings and variants are checked before dispatch. `--max-cost` stops work at observed spend; in-flight and auxiliary requests can exceed that observation, so it is not a hard billing ceiling. Default unit tests and native scripted integration make no paid calls. This change supplies the harness; no new paid-model quality result is claimed.

The native integration suite uses the global installer with isolated configuration, homes, Git roots, databases, and a local scripted model provider, with no paid model calls. Its 26 checks cover global availability, overrides and state isolation across two projects, command feedback, configuration RPC, scoped guided saves, advanced editing/reset compatibility and global reload/override behavior, production registration, plan and execution, role restrictions, native check provenance, export, restart, intents, cancellation, supervisor interruption and recovery, automatic mode, and unavailable models. The recovery check preserves accepted investigation, resumes a held dependent worker without duplicates, and confirms completion-notice delivery. Ultra-mode checks cover ordinary configuration/status results, duplicate admission, saved-plan execution, ownership, forged child/Build calls, and selection changes before admission. The [latest validation record](docs/design.md#change-installed-gpt-validation--opencode-2028-and-live-workflows) records installation, terminal checks, real GPT outcomes and limits. Evidence and logs remain under `.spike/integration-<timestamp>-<id>/`.

`bun run spike` reproduces the earlier 22-probe host compatibility matrix and requires Git. Set `OPENCODE_SPIKE_BIN` if the matching executable is outside the normal Windows npm location or `PATH`.

Set `OPENCODE_TEST_VERSION=2.0.26` or `2.0.28` together with its matching `OPENCODE_SPIKE_BIN` to run the spike or production integration suite against that host. The default remains 2.0.25. For the optional OpenChamber settings integration, point `OPENCHAMBER_SOURCE` at an OpenChamber source checkout with its dependencies installed, then run `bun run test:openchamber`. This exercises OpenChamber's real plugin-settings reader/writer against an isolated OpenCode host; it does not render the OpenChamber UI.

Offline inspection is also available:

```powershell
bun run ultra validate --config "C:\path\to\ultra-options.json"
bun run ultra render "Describe the proposed task"
bun run ultra status --project "C:\path\to\your-project"
bun run ultra export <run-id> --project "C:\path\to\your-project"
```

Offline `validate` and `render` select native plugin options from the direct global and project files, following replacement for an identical package target. They then merge `ultracode.json` and apply explicit `--config` options last. Ambiguous registrations are rejected. Use `--global-config <directory>` to preview an isolated global profile. These commands read direct files; OpenCode's native ancestor and include discovery still needs the live host. Snapshot commands read saved state without loading configuration; dispatch and lifecycle controls run inside OpenCode. For an existing native worktree, select its run location with `--project` and the canonical project's database with `--state`:

```powershell
bun run ultra inspect <run-id> --project "C:\path\to\worktree" --state "C:\path\to\main-project\.ultracode\state.sqlite"
```

- [Design and implementation record](docs/design.md): decisions, architecture, lifecycle, and remaining scope.
- [Research notes](docs/research.md): upstream behaviour and primary sources.
- [Compatibility results](docs/compatibility-spike.md): reproducible host probes and version-sensitive contracts.
- `src/engine.ts`: scheduling, recovery, budgets, and completion gates.
- `src/opencode.ts` and `src/plugin.ts`: native execution, permission hooks, and commands.
- `src/agents.ts` and `src/agent-control.ts`: primary-agent instructions and typed task/control contracts.
- `src/workflow.ts`, `src/graph.ts`, and `src/config.ts`: public prompts, graph validation, and model routing.
- `src/store.ts` and `src/artifacts.ts`: transactional history, redaction, and exports.
