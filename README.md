# Ultra Open Code

An independent, transparent implementation of thorough multi-agent workflows for OpenCode 2.

The v1 runtime is implemented: discovery, design, independent critique, implementation, review, native verification, bounded repair, and evidence-backed reporting. A persistent task graph controls asynchronous native agents while the initiating conversation stays available.

Prompts, graph revisions, model selections, native session bindings, attempts, observed context, tool activity, checks, and recovery decisions are inspectable. Model assessments and actual command evidence remain separate.

## Install globally

Requires Bun **1.3.10 or newer** and OpenCode **2.0.25 or 2.0.26**, either a CLI installation or an explicitly selected bundled executable. Only these exact host versions are accepted; Windows is verified. Git is optional for normal workflows.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run install:global
```

Run these commands from this checkout, then restart OpenCode. The plugin becomes available in each project without another installation. The installer registers this local package in the global `opencode.json` or `opencode.jsonc`, adds `ultra-supervisor` and `ultra-worker`, and sets native delegation depth to at least two. It preserves existing providers, models, and permission settings and saves the original configuration when changed. JSONC is rewritten as formatted JSON; the backup retains comments. Repeating an unchanged installation creates no extra registrations or backups. Keep this checkout available at its installed path.

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

Use `/ultracode config` to inspect effective settings in a searchable native terminal dialog. Select a setting to see its full value. This is the single terminal configuration entry point; viewing settings makes no model call. Restart the terminal client after updating this checkout so it loads the package's `tui.ts` companion. Other Ultra command results and errors also appear in native dialogs for their initiating session.

Ultra's terminal viewer is read-only. OpenCode's built-in **Open settings** action edits CLI appearance and interaction settings in `cli.json`, separately from server plugin options. Its public terminal plugin API has no settings contribution interface. An editable **Ultra settings** dialog with global/project inheritance and model pickers, and a live workflow panel are [proposed in the design](docs/design.md#change-native-ux--menu-settings-and-live-workflow-inspection); they are not implemented yet. OpenChamber can already edit the standard plugin options as described below.

Model selection order is authorised task override, run stage, run role, effective project stage, effective project role, run default, effective project default, then inheritance. Effective project mappings include inherited global defaults. Model and variant resolve together. Missing models, invalid variants, and known lack of tool support are rejected without fallback. Each attempt saves its resolved choice and origin.

When every layer omits `checks`, the plugin detects existing `test`, `typecheck`, and `lint` package scripts and maps them to the `verification` criterion. It uses Bun for a Bun lockfile and npm otherwise. An explicit `checks: []` disables inherited checks and detection. Prefer project-specific commands in `ultracode.json`; shared checks run in each selected project. Use check criterion IDs distinct from the default assessment criterion `request`.

Verifiers execute only configured commands through the native shell tool, under the real worker invocation and native permissions. Exit status, caller identity, command, directory, and candidate hash establish evidence. Execution without a required machine check ends as `partial`; a model saying “tests passed” cannot establish success.

## OpenChamber settings

OpenChamber's **Settings → Plugins** page reads and edits OpenCode's standard plugin entries. Click the card whose name is this checkout's directory path. Its **Installed plugin** detail shows **User config** for the global installation and contains **Options (JSON)**. Edit those options using the same fields shown above: `models`, `limits`, `checks`, `prompts`, and `autoThreshold`. Entries from configuration files are editable; discovered package cards are display-only. Edit the user/global entry for shared defaults, or an existing project entry for project-specific native options. OpenChamber saves the options when the editor loses focus. Use an explicit `{}` to clear that entry's options; leaving the editor blank retains them. It preserves the plugin package path and unrelated native configuration. No separate Ultra extension or custom settings service is required.

If the page says **No plugins yet**, check that the selected configuration profile still contains Ultra in its `plugins` array. Re-run the global installer against that profile to restore a missing registration, then refresh the Plugins page. The installer backs up changed configuration and preserves unrelated settings. Deleting the entry from OpenChamber removes the registration; **Options (JSON)** is where its settings are edited.

The editor shows that entry's explicit options. Ultra's built-in defaults, discovered checks, and `ultracode.json` overrides still apply in the runtime. A native project entry replaces the entire global entry's options; use `ultracode.json` for project overrides that inherit individual global fields. OpenChamber's plugin-options editor does not edit that override file. Save while workflows are settled, and reload OpenCode from OpenChamber to ensure the new settings apply. Saved runs retain their captured settings.

The released OpenChamber 2.2.0 desktop package pins OpenCode 2.0.25; its inspected development revision pins 2.0.26. Ultra accepts both exact hosts. Install Ultra in the configuration profile used by OpenChamber and OpenCode. If OpenChamber itself is launched with `OPENCODE_CONFIG`, its user plugin editor selects that custom file; otherwise it reads the global configuration directory. OpenChamber's generated child configuration leaves that parent profile intact. Remote settings targeting has not been validated. See the [integration record](docs/design.md#change-client-settings--single-command-and-openchamber-configuration) for tested scope and the remaining proposal for dedicated form controls.

## Persistence and limits

State lives under the canonical project's `.ultracode/`: SQLite state and events, content-addressed artifacts, and run exports. Exclude this directory from version control. Exported reports distinguish current accepted evidence from historical or superseded attempts and identify redactions. The HTML dashboard is a saved snapshot.

Default limits are four workers and two runs per project, 24 worker attempts per run, 24 model steps per worker, two repair rounds, ten minutes per worker, 45 minutes of active run time, and a 24-hour elapsed deadline. Permission waits retain their slots and count towards active worker/run deadlines; pausing stops the run clock once active work settles.

One writer is admitted per project; independent read-only tasks can run concurrently. Candidate fingerprints invalidate stale results. Unknown launch or cancellation outcomes retain reservations until native reconciliation establishes settlement. Multiple locations in one OpenCode server share coordination; use one server to manage concurrent runs in a project. Independent processes are fenced and queued, with limited throughput rather than distributed scheduling.

Parallel worktree integration, an editable native settings UI and workflow dashboard, arbitrary JavaScript workflow builders, and dedicated mixed-model panels remain future extensions. A native terminal configuration viewer and command feedback are available. `parallelWrites: true` is rejected. The worktree primitive is tested in the compatibility spike, but production workflows use the single writer policy.

The trace covers rendered prompts and supported host observations. It cannot expose private model reasoning or guarantee an exact provider request or complete native event replay: this CLI does not retain native event payload history. Recovery records that gap and reconciles live session snapshots. This implements a similar public workflow pattern to Claude; output quality and feature parity have not been established.

Models submit results through an explicit nested tool schema, with task-specific criterion guidance and a short example. The engine validates submissions before persistence and still checks graph policy and actual native evidence separately. Bounded repair retains the admitted writers' file scope. These contracts are provider-independent; actual model quality needs separate evaluation. The native execution bridge retains permission checks but relies on source ordering and bypasses outer tool hooks, which is why compatibility remains pinned and tested rather than assumed for every OpenCode version or third-party plugin.

## Verification and source map

```powershell
bun run typecheck
bun run test
bun run test:integration
```

The native integration suite uses the global installer with isolated configuration, homes, Git roots, databases, and a local scripted model provider, with no paid model calls. It tests global availability, overrides and state isolation across two projects, command feedback without queued model input, configuration RPC, production registration, plan and execution, role restrictions, native check provenance, export, restart, expired intents, cancellation, automatic mode, and unavailable models. Actual terminal rendering is checked separately; the [current delivery record](docs/design.md#change-client-settings--single-command-and-openchamber-configuration) records its scope. Evidence and logs remain under `.spike/integration-<timestamp>-<id>/`.

`bun run spike` reproduces the earlier 22-probe host compatibility matrix and requires Git. Set `OPENCODE_SPIKE_BIN` if the matching executable is outside the normal Windows npm location or `PATH`.

Set `OPENCODE_TEST_VERSION=2.0.26` together with its matching `OPENCODE_SPIKE_BIN` to run the spike or production integration suite against that host. The default remains 2.0.25. For the optional OpenChamber settings integration, point `OPENCHAMBER_SOURCE` at an OpenChamber source checkout with its dependencies installed, then run `bun run test:openchamber`. This exercises OpenChamber's real plugin-settings reader/writer against an isolated OpenCode host; it does not render the OpenChamber UI.

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
