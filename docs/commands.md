# Workflow commands and runtime behaviour

[Back to README](../README.md) · [Configuration](configuration.md) · [Installation](installation.md)

## Conversational workflows

Select **GigaCode** in your native agent picker and describe the task:

```text
Plan resumable uploads for this API. Stop at a proposal.
Implement the agreed upload changes and tests.
Show the effective GigaCode settings.
What is the current workflow status?
Pause the current workflow.
```

GigaCode uses the existing graph engine through native `gigacode_task` and `gigacode_control` tools. General questions, configuration inspection, and clarification remain conversation; they do not automatically admit a graph based on prompt length. Planning saves a read-only proposal. Implementation requests authorise design and execution within their scope, under native permissions. Role and stage model settings continue to apply.

Agent use adapts to the request. Simple explanations and lookups can use read tools without workers. A focused design can use one planning worker. When GigaCode has enough context for a small implementation, it supplies a scoped writer, independent reviewer and configured verifier directly, skipping a planning team. Larger tasks can add useful specialists and dependencies. Research, critique, reconciliation and reporting workers are optional. The model chooses the graph through a typed `workflow: { rationale, tasks }` field; there is no keyword complexity classifier or extra routing model. The engine preserves the request and check criteria and rejects unsafe graphs before dispatch. Omitted graphs, including explicit command starts, begin with one combined planner.

GigaCode's replies explain concrete code findings, design decisions, behavior changes, and test evidence. Starting a task supplies its objective and bounded task purposes, so the opening can explain the intended investigation or changes. Background completion brings results back to the conversation; the guidance avoids repeated status polling. Completed work supplies accepted technical summaries rather than only task counts and file paths. Detailed scheduling information remains available through inspection when needed.

Progress and results use normal native tool and subagent activity. Follow-up controls stay bound to their initiating conversation; repeated calls cannot launch the same intent twice. Selecting Build or Plan does not cancel a workflow. The initiating conversation retains coordinator restrictions while its run is active, including while paused; cancel or finish that run before direct project edits there. Other conversations retain their normal agent behaviour. The model selects tools from clear schemas; actual model quality and instruction following require separate evaluation.

Each worker has a saved native child-session identity. Recovery reconciles those sessions before continuing; an unknown launch or session outcome requires inspection rather than another dispatch. A returning bound supervisor can continue its existing attempts after interruption. In OpenCode's terminal, open **Subagents** with Down from the empty composer. The native panel shows the supervisor and its nested workers, including after reopening the conversation. It defaults to running agents; **Ctrl+A** switches to inactive agents and back. An empty active panel does not establish whether a launch failed or the work already finished. Restart the terminal after updating the installed package to load the companion fix. Other native clients use their own session presentation; OpenChamber exposes workers inside the supervisor's conversation.

Conversational inspection returns a compact, redacted view of actual task attempts and native checks. It keeps valid JSON below 30,000 bytes, prioritizes accepted and recent evidence, reports omitted records, and includes bounded log previews and engine failure reasons. Whole-run summaries use accepted, native-succeeded results at the saved candidate and include a ready plan's exact proposal revision. Ask for a specific task's evidence to inspect historical results; RPC inspection and exported audits retain the full redacted history.

In the OpenCode terminal, start with a plan and open the workflow control panel:

```text
/gigacode plan Add resumable uploads to the API
/gigacode status
```

In **GigaCode workflows**, highlight the planned workflow and press **Enter** or **Actions** (**Ctrl+A**) to open **GigaCode workflow actions**. Choose **Inspect** to review its saved state. **Run saved proposal** confirms the objective, run ID, and exact saved revision before execution checks workspace freshness. Separate **Run ID** and **Saved proposal revision** rows show those values in the main panel, which supplies them to its actions; copying IDs is optional. The action menu also offers **Export** and eligible **Pause**, **Resume**, **Cancel**, and **Open agent session** choices. Settings are opened separately with `/gigacode config`.

For advanced use, the exact-ID command forms remain available:

```text
/gigacode inspect <run-id>
/gigacode run <run-id>@<saved-revision>
/gigacode status <run-id>

/gigacode start Implement the agreed upload changes and tests
```

`plan` stops at a saved proposal. `run` executes an exact saved revision after checking workspace freshness. `start` authorises design and implementation within the requested scope. Native permission requests still apply.

## Commands

| Command | Purpose |
| --- | --- |
| `start <task>` / `-- <task>` | Design and execute a workflow. |
| `plan <task>` | Read-only discovery, design, critique, and saved proposal. |
| `run <id>@<revision>` | Execute a fresh saved proposal. |
| `status [id]` | Open the workflow control panel, optionally filtered to one run. |
| `inspect <id> [task-id]` | Inspect saved state, attempts, prompts, models, and events. |
| `pause <id>` / `resume <id>` | Drain active work, or reconcile and continue it. |
| `cancel <id>` | Interrupt agents; retain partial work and history. |
| `retry <id> <task-id>` | Retry an eligible settled failed task with a new attempt. |
| `input <id> <answer>` | Answer a recorded worker question and refresh affected tasks. |
| `budget <id> <limits-json>` | Explicitly increase limits for a paused or budget-blocked run. |
| `export <id>` | Write JSON, Markdown, and a read-only HTML dashboard. |
| `config` | Open the separate guided settings editor. |
| `on` / `off` | Persistently enable or disable automatic mode in this session. |

Prefix every command with `/gigacode`. IDs can be shortened when unambiguous. Mutating controls must come from the run's initiating conversation and location; workers cannot issue them. Status, inspection, configuration, and other control handlers do not need a model call, although starting or continuing work admits native model execution.

Automatic command mode is explicit opt-in for other primary agents. After `on`, ordinary prompts of at least `autoThreshold` characters (default **80**) start an execution workflow when the session has no active run. GigaCode mode always interprets requests through its tools, regardless of that opt-in or threshold. `off` affects future automatic prompts; cancelling an existing run is separate.

```text
/gigacode input <run-id> Use the existing API rather than adding a new endpoint.
/gigacode budget <run-id> {"attempts":36,"runMs":3600000}
/gigacode resume <run-id>
```

## Read-only recipes and live progress

Explicit recipes reuse the same graph engine, model settings and permissions:

| Recipe | Work |
| --- | --- |
| `deep-review` | Independent behavior and failure/security reviews, followed by evidence-based reconciliation. |
| `bug-investigation` | Trace the failing path and alternative causes, then explain the root cause and regression strategy. |
| `cross-checked-research` | Independently establish the primary contract and counterexamples, then reconcile versions, citations and uncertainty. |

```text
/gigacode plan --recipe deep-review Review the retry handling
/gigacode plan --recipe bug-investigation Explain the timeout regression
/gigacode plan --recipe cross-checked-research Compare the supported API versions
```

In GigaCode mode, explicitly ask for the named recipe, or use `gigacode_task` with `mode: "plan"` and `recipe`. Recipes cannot be combined with an authored `workflow` or execute mode. A completed report can reach `ready` without manufacturing an implementation proposal; unresolved blocking findings remain `partial`. A justified worker-authored corrective proposal still requires explicit exact-revision execution. Preview a recipe offline with `gigacode render --recipe deep-review "Review the public API"`.

In the OpenCode terminal, `/gigacode status` opens **GigaCode workflows**, a live searchable control panel for the current initiating conversation. An optional ID filters the panel to one run. Workflow details show the run ID, current revision, and saved proposal revision when available, alongside task/model/session identities, dependency and permission waits, accepted results, unresolved findings, native evidence, and observed worker usage.

Highlight a workflow or one of its rows and press **Enter** or **Actions** (**Ctrl+A**). The vertical **GigaCode workflow actions** menu offers:

| Action | Purpose |
| --- | --- |
| Inspect | Browse the workflow's saved state. |
| Run saved proposal | Confirm and execute a ready workflow's exact saved proposal revision. |
| Export | Write JSON, Markdown, and HTML audit reports. |
| Pause | Drain active work. |
| Resume | Reconcile and continue eligible work. |
| Cancel | Interrupt work while retaining partial changes and history. |
| Open agent session | Open the selected native worker or the workflow's supervisor. |
| Back | Return to the workflow panel. |

**Run saved proposal** is available only for a ready workflow with a saved proposal revision. Its confirmation identifies the objective, run ID, and revision; execution still checks freshness and native permissions. Pause, Resume, and Cancel retain the initiating-session ownership checks and appear when eligible. Settings are managed through `/gigacode config`.

**Inspect** opens a page picker for the overview, proposal, tasks, errors, and recent event summaries. Select a page to read its details; **Escape** returns to the picker, then to the workflow panel. Large sections are bounded and show omission notes; export provides the full redacted audit. **Export** lists the saved JSON, Markdown, and HTML report paths, then returns to the workflow panel. The selected workflow stays highlighted when you return.

Snapshots refresh every two seconds only while the panel is open, and immediately after controls or reconnect. Historical checks and repaired findings cannot masquerade as current final evidence. Unknown or partially observed usage is labelled explicitly; worker totals exclude unobserved supervisor and auxiliary costs. OpenChamber still lacks the RPC bridge needed to display this native terminal panel.

## Persistence and limits

GigaCode stores state only under the canonical project's `.gigacode/`: SQLite state and events, content-addressed artifacts, and run exports. It starts its own run history and does not discover or import previous products' runtime directories. Exclude `.gigacode/` from version control. Exported reports distinguish current accepted evidence from historical or superseded GigaCode attempts and identify redactions. The HTML dashboard is a saved snapshot.

Default limits are four workers and two runs per project, 24 worker attempts per run, 24 model steps per worker, two repair rounds, ten minutes per worker, 45 minutes of active run time, and a 24-hour elapsed deadline. Permission waits retain their slots and count towards active worker/run deadlines; pausing stops the run clock once active work settles.

One execution run owns a project at a time. Writers run serially by default; independent read-only tasks can run concurrently. Candidate fingerprints invalidate stale results. Unknown launch or cancellation outcomes retain reservations until native reconciliation establishes settlement. Multiple locations in one OpenCode server share canonical state and coordination; use one server to manage concurrent runs in a project. Independent processes are fenced and queued, with limited throughput rather than distributed scheduling.

Set `"parallelWrites": true` in native options or `gigacode.json` to isolate graphs with at least two independent writers. They require a clean committed canonical Git root without submodules or configured Git filters. A generated preparation worker creates fixed recorded checkouts through native permission-checked Git commands, with repository hooks disabled. This avoids OpenCode's worktree-create startup-command shortcut. Workers move to their recorded locations and receive destination permission hooks before the task prompt. A serial native integration worker applies accepted immutable changes; independent review and configured checks run against the final root. A single-writer graph keeps its normal three-worker path.

The initial parallel mode supports disjoint plain UTF-8 additions and modifications, with a 2 MB captured-text limit per writer. Dependent writing sequences, overlapping paths, deletes, binaries, symlinks, hardlinks, mode changes, and changes omitted by the source manifest are refused; partial worktrees remain inspectable. Retrying or resetting an isolated writer requires a new run. Root freshness is checked before and after native operations; the host's native write primitive does not provide an atomic compare-and-write guarantee against concurrent external edits during permission waits. Keep external edits settled while integrating. Worktrees are never force-removed. A dedicated graph panel, arbitrary JavaScript builders and mixed-model comparison panels remain future extensions.

The trace covers rendered prompts and supported host observations. It cannot expose private model reasoning or guarantee an exact provider request or complete native event replay: this CLI does not retain native event payload history. Recovery records that gap and reconciles live session snapshots. This implements a similar public workflow pattern to Claude; output quality and feature parity have not been established.

Models submit results through an explicit nested tool schema, with task-specific criterion guidance and a short example. The engine validates submissions before persistence and still checks graph policy and actual native evidence separately. Bounded repair retains the admitted writers' file scope. These contracts are provider-independent; actual model quality needs separate evaluation. The native execution bridge retains permission checks but relies on source ordering and bypasses outer tool hooks, which is why compatibility remains pinned and tested rather than assumed for every OpenCode version or third-party plugin.

## Offline CLI

`gigacode doctor [--json] [--project <directory>] [--global-config <directory>]` checks the installed package, Bun, selected OpenCode host, profile registrations, agents, delegation depth, and configuration syntax. It reports local configuration health without changing configuration or project runtime state, exposing provider/model/option values, or making model or network calls. An explicit host version probe may use a disposable isolated profile. Exit status is 1 for failed checks, otherwise 0; warnings and unverified live checks are labelled. See [diagnostics and limitations](installation.md#troubleshooting).

```powershell
gigacode doctor
gigacode doctor --json
gigacode validate --config "C:\path\to\gigacode-options.json"
gigacode render "Describe the proposed task"
gigacode status --project "C:\path\to\your-project"
gigacode export <run-id> --project "C:\path\to\your-project"
```

Offline `validate` and `render` select native plugin options from the direct global and project files, following replacement for an identical package target. They then merge `gigacode.json` and apply explicit `--config` options last. Ambiguous registrations are rejected. Use `--global-config <directory>` to preview an isolated global profile. These commands read direct files; OpenCode's native ancestor and include discovery still needs the live host. Snapshot commands read saved state without loading configuration; dispatch and lifecycle controls run inside OpenCode. For an existing native worktree, select its run location with `--project` and the canonical project's database with `--state`:

```powershell
gigacode inspect <run-id> --project "C:\path\to\worktree" --state "C:\path\to\main-project\.gigacode\state.sqlite"
```
