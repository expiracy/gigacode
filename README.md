# Ultra Open Code

An independent, transparent implementation of thorough multi-agent workflows for OpenCode 2.

The v1 runtime is implemented: discovery, design, independent critique, implementation, review, native verification, bounded repair, and evidence-backed reporting. A persistent task graph controls asynchronous native agents while the initiating conversation stays available.

Prompts, graph revisions, model selections, native session bindings, attempts, observed context, tool activity, checks, and recovery decisions are inspectable. Model assessments and actual command evidence remain separate.

## Install globally

Requires Bun **1.3.10 or newer** and installed `@opencode/cli` **2.0.25**. This exact host version is enforced; Windows is verified. Git is optional for normal workflows.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run install:global
```

Run these commands from this checkout, then restart OpenCode. The plugin becomes available in each project without another installation. The installer registers this local package in the global `opencode.json` or `opencode.jsonc`, adds `ultra-supervisor` and `ultra-worker`, and sets native delegation depth to at least two. It preserves existing providers, models, and permission settings and saves the original configuration when changed. JSONC is rewritten as formatted JSON; the backup retains comments. Repeating an unchanged installation creates no extra registrations or backups. Keep this checkout available at its installed path.

The global directory is `OPENCODE_CONFIG_DIR` when set, otherwise `XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when XDG is unset. These are OpenCode 2.0.25's paths on Windows too. To select another global directory, use `--config-dir`; OpenCode must use the same directory through `OPENCODE_CONFIG_DIR`.

An optional standalone project installation remains available:

```powershell
bun run install:project --project "C:\path\to\your-project"
```

For a globally installed plugin, use the project override file described below. An existing project registration targeting the same plugin replaces its global native options under OpenCode's rules. To inherit global defaults, move that registration's `options` into `ultracode.json` and remove only its Ultra entry from the project's `plugins` array, preserving other plugins and native settings. Different package references for the same plugin can create duplicate IDs; use the single global registration.

Select a connected model in OpenCode, then use:

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

Automatic mode is explicit opt-in. After `on`, ordinary prompts of at least `autoThreshold` characters (default **80**) start an execution workflow when the session has no active run. This is a transparent length rule, not a hidden complexity classifier. `off` affects future prompts; cancelling an existing run is separate.

```text
/ultracode input <run-id> Use the existing API rather than adding a new endpoint.
/ultracode budget <run-id> {"attempts":36,"runMs":3600000}
/ultracode resume <run-id>
```

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

Model selection order is authorised task override, run stage, run role, effective project stage, effective project role, run default, effective project default, then inheritance. Effective project mappings include inherited global defaults. Model and variant resolve together. Missing models, invalid variants, and known lack of tool support are rejected without fallback. Each attempt saves its resolved choice and origin.

When every layer omits `checks`, the plugin detects existing `test`, `typecheck`, and `lint` package scripts and maps them to the `verification` criterion. It uses Bun for a Bun lockfile and npm otherwise. An explicit `checks: []` disables inherited checks and detection. Prefer project-specific commands in `ultracode.json`; shared checks run in each selected project. Use check criterion IDs distinct from the default assessment criterion `request`.

Verifiers execute only configured commands through the native shell tool, under the real worker invocation and native permissions. Exit status, caller identity, command, directory, and candidate hash establish evidence. Execution without a required machine check ends as `partial`; a model saying “tests passed” cannot establish success.

## Persistence and limits

State lives under the canonical project's `.ultracode/`: SQLite state and events, content-addressed artifacts, and run exports. Exclude this directory from version control. Exported reports distinguish current accepted evidence from historical or superseded attempts and identify redactions. The HTML dashboard is a saved snapshot.

Default limits are four workers and two runs per project, 24 worker attempts per run, 24 model steps per worker, two repair rounds, ten minutes per worker, 45 minutes of active run time, and a 24-hour elapsed deadline. Permission waits retain their slots and count towards active worker/run deadlines; pausing stops the run clock once active work settles.

One writer is admitted per project; independent read-only tasks can run concurrently. Candidate fingerprints invalidate stale results. Unknown launch or cancellation outcomes retain reservations until native reconciliation establishes settlement. Multiple locations in one OpenCode server share coordination; use one server to manage concurrent runs in a project. Independent processes are fenced and queued, with limited throughput rather than distributed scheduling.

Parallel worktree integration, a native TUI, arbitrary JavaScript workflow builders, and dedicated mixed-model panels remain future extensions. `parallelWrites: true` is rejected. The worktree primitive is tested in the compatibility spike, but production workflows use the single writer policy.

The trace covers rendered prompts and supported host observations. It cannot expose private model reasoning or guarantee an exact provider request or complete native event replay: this CLI does not retain native event payload history. Recovery records that gap and reconciles live session snapshots. This implements a similar public workflow pattern to Claude; output quality and feature parity have not been established.

## Verification and source map

```powershell
bun run typecheck
bun run test
bun run test:integration
```

The native integration suite uses the global installer with isolated configuration, homes, Git roots, databases, and a local scripted model provider, with no paid model calls. It tests global availability, overrides and state isolation across two projects, production registration, plan and execution, role restrictions, native check provenance, export, restart, expired intents, cancellation, automatic mode, and unavailable models. Evidence and logs remain under `.spike/integration-<timestamp>-<id>/`.

`bun run spike` reproduces the earlier 22-probe host compatibility matrix and requires Git. Set `OPENCODE_SPIKE_BIN` if the matching executable is outside the normal Windows npm location or `PATH`.

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
- `src/workflow.ts`, `src/graph.ts`, and `src/config.ts`: public prompts, graph validation, and model routing.
- `src/store.ts` and `src/artifacts.ts`: transactional history, redaction, and exports.
