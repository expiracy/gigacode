# Configuration

[Back to README](../README.md) · [Installation](installation.md) · [Workflow commands](commands.md)

## Models, checks, and prompts

By default, every role inherits the initiating session's captured model and variant. To configure shared defaults, create a JSON file and pass it to the global installer:

```powershell
gigacode setup --global --config "C:\path\to\gigacode-options.json"
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

To override selected defaults for one project, add an optional `gigacode.json` in the directory where OpenCode runs:

```json
{
  "models": { "roles": { "reviewer": "other-provider/project-review-model" } },
  "limits": { "workers": 2 },
  "prompts": { "reviewer": "Check this project's public API compatibility." }
}
```

The plugin merges OpenCode's effective native plugin options with this file, then supplies built-in defaults. Models by role or stage, limits, and prompts merge field by field. Scalars replace inherited values; `checks` replaces the entire inherited array, including an explicit `[]`. Each layer is validated independently. No override file or project installation is required. The plugin reads only the exact session directory's `gigacode.json`; it does not search parent directories or fall back to another product's settings file. Restart OpenCode after editing it. New GigaCode runs capture the resulting configuration; saved GigaCode runs retain their captured settings.

Use `/gigacode config` to open **GigaCode settings**. The first screen offers **This project**, **Global defaults**, **Help**, and **About GigaCode**. Choose a scope, then **Models**, **Limits**, **Checks** or **Advanced configuration**. Editable values appear only in their editable section; there is no separate read-only list of the same limits or models. Restart the terminal client after updating the installed package so it loads the package's `tui.ts` companion. Other GigaCode command results and errors also appear in native dialogs for their initiating session.

**This project** changes this location; **Global defaults** changes defaults for projects using the server's OpenCode profile. Project overrides take precedence. The chosen scope stays visible inside each section and check-entry step. **Models** selects a default, role or stage mapping from connected models with tool support, including variants. Reset removes an override; **Use chat model** explicitly stores `inherit`, displayed as **Chat model**. Stage mappings take precedence over role mappings. Each section stays open while you make multiple changes and remembers your selection. Back names the parent screen; Back or Escape from a model variant returns to model selection without changing the mapping.

**Limits** shows current values and their source. Select a limit to edit it directly; the list stays open for multiple edits. Deadlines use seconds, including fractional seconds to millisecond precision. Press **Ctrl+R** on a limit to restore its inherited value, or its built-in default when editing globally. The numeric prompt also accepts `inherit` for project values or `default` for global values. Invalid input stays available for correction. **Checks** adds, edits or removes verification commands, criterion IDs and optional timeouts. Its four-step form validates each field before continuing and retains invalid input for correction; cancelling stages no partial check. Project check lists replace the inherited list. Resetting global checks restores discovery in each project unless overridden. An explicit empty list disables configured checks and prevents verified execution success.

Changes stay in a draft until the scoped **Save** action shows the target file, exact changes and impact, and you confirm. Reviews include scope, target file and concrete reset values. Restoring the original values clears the unsaved state. **Back to GigaCode settings** returns to scope, Help and About choices; leaving a changed draft requires explicit discard. Navigation or reconnect retires the editor. Existing files are backed up, stale revisions are rejected, and saving requires settled workflows. While saving is blocked, **Recheck save availability** refreshes workflow state without losing the draft. If the target settings changed on disk, the draft stays available for review but cannot overwrite the newer revision; reopen the scope to load it.

Project saves write this location's `gigacode.json`, preserve other options, and apply to new workflows immediately. Global saves update only GigaCode's editable options in the active native `opencode.json` or `opencode.jsonc`, preserving comments, credentials, other plugins and unrelated options. The server uses `OPENCODE_CONFIG` when set, otherwise its configured global directory. A unique direct GigaCode registration is required; ambiguous or symlinked profiles are refused. Global saves require an OpenCode reload to apply across projects. Existing runs keep captured settings; configuration changes can invalidate saved plan fingerprints. Backups live under `.gigacode/settings-backups/` beside the native profile for global saves, or in the project's runtime directory for project saves.

**Help** offers short guides to **Scopes & inheritance**, **Editing & saving**, **Advanced controls**, and **Workflow commands**. Closing a guide returns to the same topic; Back or Escape returns to settings. **About GigaCode** opens directly from settings and shows GigaCode's purpose, versions, project directory and state location.

**Advanced configuration** edits role instructions, writer policy and the automatic-mode threshold inside either scope. Role text supports multiple lines and supplements built-in guidance. Use **Ctrl+R** on a role, or submit blank text, to restore inherited/built-in instructions. Writer policy offers serial writers or isolated parallel writers; parallel writing requires a clean committed Git root and native Git permissions. The threshold sets the minimum prompt length for the existing per-conversation automatic mode after `/gigacode on`; changing it does not enable that mode or change GigaCode mode. Enter `inherit` (project) or `default` (global) in the threshold prompt to restore its inherited/default value. Every edit joins the same draft and confirmed save; JSON editing is optional. Settings operations make no model calls. OpenCode's built-in **Open settings** action edits CLI appearance and interaction settings in `cli.json`. OpenChamber can edit standard plugin options as described below; the guided editor uses the native OpenCode terminal companion.

Model selection order is authorised task override, run stage, run role, effective project stage, effective project role, run default, effective project default, then inheritance. Effective project mappings include inherited global defaults. Model and variant resolve together. Missing models, invalid variants, and known lack of tool support are rejected without fallback. Each attempt saves its resolved choice and origin.

Versioned task prompts explain the role, scope, criteria, configured checks, and typed submission contract. Generated instructions refer to the objective rather than repeating it; roles that cannot propose execution omit the graph schema and model catalogue. Writers omit assessment fields; other roles choose only existing assessment IDs. Unused input requests should be omitted. Handoffs limit each narrative summary to 6,000 characters, with captured identities and retrieval directions for omitted evidence. The initial task prompt has a default aggregate limit of **64,000 characters**, configurable with `limits.contextChars`. Oversized dependencies become saved-result references; bound workers use paginated `gigacode_dependency` reads to retrieve immutable captured results. Model-facing check logs and routine progress are bounded previews; the saved evidence and structured tool outputs retain the existing audit records.

When OpenCode supplies native model limits, GigaCode also estimates initial text headroom from the smaller of input capacity and context capacity after an output reserve. It reserves up to 2,048 output tokens and half the remaining input for native instructions, schemas and history, then conservatively treats each allowed byte as a token. This is a UTF-8 byte estimate, not a tokenizer measurement or a guarantee that every later native request fits. Dependency pages and check-log previews also use this headroom. Required instructions, user clarifications and criteria are never clipped. If they cannot fit, dispatch stops in `waiting_budget` before creating a worker attempt. Increase a restrictive manual cap only when the model has headroom; otherwise shorten the request or select a larger-context model. Older models and saved attempts without capacity metadata keep the manual cap.

For local or hosted free models, select a model with tool support and keep every GigaCode role and stage on `inherit`. [The local profile](../examples/gigacode-local.json) overrides existing role/stage mappings, permits one worker and one run at a time, and uses a 16,000-character manual cap. Merge it into the project's `gigacode.json`, preserve the project's real checks and other settings, and restart OpenCode. Configure native title, summary and compaction agents to use the same local/free model too, so auxiliary host requests do not use a paid default. Set the provider's context/input/output limits to the window actually configured in your inference server, rather than its training maximum. See [OpenCode model configuration](https://dev.opencode.ai/v2/docs/models/).

One planner is the default for investigation. A bounded implementation can use a scoped writer, independent review and assigned checks directly; extra research/reconciliation workers are explicit choices. Fresh role contexts, independent review and actual check evidence can improve consistency, but do not guarantee better answers from every model. GigaCode never switches to a paid model when the chosen model is unavailable or a budget is exhausted. Long native histories and source-file reads still consume the host's context and may require native compaction; previews must not be treated as complete inspection.

[The local validation record](https://github.com/expiracy/gigacode/blob/main/docs/design.md#change-local-model-efficiency--smaller-handoffs-and-native-capacity-headroom) reports the reductions and actual outcomes. The 4B model's narrower submissions reduced errors and requests, but its feature candidate still failed the independent boundary oracle. Hosted free access was rejected by the provider. Neither case establishes reliable task completion or guaranteed quality.

For test-first work, proposal workers see the configured check catalogue and can plan a test-writing worker, a verifier recording the expected failure, an implementation worker, and independent final review and verification. Writers edit their owned files; only assigned verifiers execute configured commands. Historical failures remain inspectable, while completion requires evidence against the final workspace. Pending downstream proof makes no assessment claim; an actual failed assessment still prevents success.

When every layer omits `checks`, the plugin detects existing `test`, `typecheck`, and `lint` package scripts and maps them to the `verification` criterion. It uses Bun for a Bun lockfile and npm otherwise. An explicit `checks: []` disables inherited checks and detection. Prefer project-specific commands in `gigacode.json`; shared checks run in each selected project. Use check criterion IDs distinct from the default assessment criterion `request`.

Verifiers execute only configured commands through the native shell tool, under the real worker invocation and native permissions. Exit status, caller identity, command, directory, and candidate hash establish evidence. Execution without a required machine check ends as `partial`; a model saying “tests passed” cannot establish success.

## OpenChamber settings

OpenChamber's **Settings → Plugins** page reads and edits OpenCode's standard plugin entries. Click the GigaCode card identified by the installed package path. Its **Installed plugin** detail shows **User config** for the global installation and contains **Options (JSON)**. Edit those options using the same fields shown above: `models`, `limits`, `checks`, `prompts`, and `autoThreshold`. Entries from configuration files are editable; discovered package cards are display-only. Edit the user/global entry for shared defaults, or an existing project entry for project-specific native options. OpenChamber saves the options when the editor loses focus. Use an explicit `{}` to clear that entry's options; leaving the editor blank retains them. It preserves the plugin package path and unrelated native configuration. No separate GigaCode extension or custom settings service is required.

If the page says **No plugins yet**, check that the selected configuration profile still contains GigaCode in its `plugins` array. Re-run `gigacode setup --global` against that profile to restore a missing registration, then refresh the Plugins page. The installer backs up changed configuration and preserves unrelated settings. Deleting the entry from OpenChamber removes the registration; **Options (JSON)** is where its settings are edited.

Choose **GigaCode** in OpenChamber's agent picker and ask for settings, status, or project work in chat. Its normal native tool results use OpenChamber's supported session event path. If OpenChamber's **Auto** model option hides the picker, select an explicit connected model first. Immediate child status shows the supervisor; opening that child conversation exposes its workers. Custom GigaCode tools use generic tool cards; this provides basic workflow feedback rather than a live graph dashboard. Configuration inspection through chat involves the selected model; edit settings through **Options (JSON)** above.

OpenChamber 2.2.0 still does not display GigaCode's deterministic native slash-command results. `/gigacode` can appear in autocomplete and execute, but the client discards the RPC events used for feedback. `/gigacode config`, status, inspection, and other deterministic command results therefore have no desktop viewer. The terminal companion is loaded only by OpenCode's terminal client. A supported OpenChamber client bridge is [proposed in the design](https://github.com/expiracy/gigacode/blob/main/docs/design.md#change-openchamber-commands--native-command-result-presentation) for model-free command presentation; GigaCode mode provides the conversational entry point independently.

The editor shows that entry's explicit options. GigaCode's built-in defaults, discovered checks, and `gigacode.json` overrides still apply in the runtime. A native project entry replaces the entire global entry's options; use `gigacode.json` for project overrides that inherit individual global fields. OpenChamber's plugin-options editor does not edit that override file. Save while workflows are settled, and reload OpenCode from OpenChamber to ensure the new settings apply. Saved runs retain their captured settings.

The released OpenChamber 2.2.0 desktop package pins OpenCode 2.0.25; its inspected development revision pins 2.0.26. Those exact hosts remain supported alongside 2.0.28. Install GigaCode in the configuration profile used by OpenChamber and OpenCode. If OpenChamber itself is launched with `OPENCODE_CONFIG`, its user plugin editor selects that custom file; otherwise it reads the global configuration directory. OpenChamber's generated child configuration leaves that parent profile intact. Remote settings targeting has not been validated. See the [integration record](https://github.com/expiracy/gigacode/blob/main/docs/design.md#change-client-settings--single-command-and-openchamber-configuration) for tested scope and the remaining proposal for dedicated form controls.

