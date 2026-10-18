# GigaCode

Inspectable multi-agent workflows for OpenCode 2. GigaCode can investigate a task, save a proposal, implement an approved revision, review changes, and run configured checks. Prompts, model choices, worker sessions, attempts, and command evidence remain available for inspection.

For example, ask it to plan resumable uploads, inspect the saved proposal, then execute that exact revision. Planning stops before implementation; execution still follows OpenCode's native permissions.

**Release status: 0.1.0-alpha.1, unpublished.** The npm package name is `opencode-gigacode`; the command and OpenCode agent remain `gigacode`. The intended release tag is `next`. This repository keeps `private: true` to prevent accidental publication.

The source repository and linked guides are currently private. A public source/docs destination must be chosen and the links updated before npm release.

GigaCode is independent and is not affiliated with or endorsed by Anthropic, OpenCode, OpenChamber, or OpenUltraCode.

## Requirements

- Bun **1.3.10 or newer**. Bun is required at runtime, including for the TypeScript CLI and SQLite storage.
- OpenCode **2.0.25, 2.0.26, or 2.0.28**. Only these exact versions are accepted; this can be a CLI installation or an explicitly selected bundled executable.
- A connected model with tool support. By default, every role inherits your conversation's model and variant.

Native 2.0.28 compatibility, production integration, and isolated parallel workflows have been verified on macOS. Earlier Windows verification is recorded in the development history; other platform/version combinations are not established by that result. Git is optional for ordinary workflows and required for isolated parallel writers.

## Install the release candidate

Until publication, install a local tarball. From this repository, create an output directory outside the checkout, then run these commands with its absolute path:

```sh
npm pack --ignore-scripts --pack-destination /absolute/path/to/release-artifacts
npm install --global /absolute/path/to/release-artifacts/opencode-gigacode-0.1.0-alpha.1.tgz
gigacode setup --global
```

Restart OpenCode, connect a model, and choose **GigaCode** beside **Build** and **Plan**. Setup registers the installed global package, adds its primary/supervisor/worker agents, and enables native delegation depth of at least two. It preserves unrelated providers, models, and permission rules, and backs up changed configuration. Keep the global package installed while its registration is in use.

After a future npm release, the first two commands can be replaced with `npm install --global opencode-gigacode@next`. Bun remains required at runtime. That registry installation is not available through this unpublished checkout.

See [installation, bundled executables, updates, and removal](https://github.com/expiracy/gigacode/blob/main/docs/installation.md) for profile selection, project-only setup, and troubleshooting.

For local diagnostics, run `gigacode doctor`, or `gigacode doctor --json` for a structured report. It checks the installed package, host, and configuration without changing configuration or calling models. Model availability and native permissions still require the live host.

## Try a plan, inspect it, then run it

In the OpenCode terminal:

```text
/gigacode plan Add resumable uploads to this API
/gigacode status
```

In **GigaCode workflows**, highlight the planned workflow and press **Enter** or **Actions** (**Ctrl+A**) to open its action menu. Choose **Inspect** to review it. When the proposal is ready, choose **Run saved proposal** and confirm the objective, run ID, and saved revision. Execution checks workspace freshness. The panel supplies the ID and revision, so you do not need to type them.

`/gigacode status` is the terminal's workflow control panel: inspect progress and evidence, export a report, pause, resume, cancel, or open a worker session for the selected workflow. Settings have their own entry point, `/gigacode config`. Switching to Build or Plan does not cancel active work; finish or cancel the workflow before editing directly in that conversation.

You can also ask GigaCode naturally: “Plan resumable uploads. Stop at a proposal,” then “Implement the agreed upload changes and tests.” General questions and settings inspection do not automatically start a workflow. [Advanced commands](https://github.com/expiracy/gigacode/blob/main/docs/commands.md#commands) remain available when you want to supply IDs explicitly.

## Configure verification for your project

When no checks are configured, GigaCode discovers existing `test`, `typecheck`, and `lint` package scripts. To choose checks explicitly, create `gigacode.json` in the exact directory where OpenCode runs. Replace these example commands with checks that exist in your project:

```json
{
  "checks": [
    { "id": "tests", "command": "bun run test", "criterionIds": ["verification"], "timeoutMs": 120000 },
    { "id": "types", "command": "bun run typecheck", "criterionIds": ["verification"], "timeoutMs": 120000 }
  ]
}
```

Restart OpenCode after editing the file. New runs capture those settings; saved runs retain theirs. Project fields inherit global defaults, but `checks` replaces the whole inherited list. An explicit `checks: []` also disables discovery. Execution without a required machine check ends as `partial`; a model's claim that tests passed cannot establish verified success.

Use `/gigacode config` for the terminal's guided settings editor. See [models, checks, prompts, and settings](https://github.com/expiracy/gigacode/blob/main/docs/configuration.md) for inheritance, model routing, limits, and local-model guidance.

## Permissions, costs, and stored data

Workers use native OpenCode sessions and permissions. Implementation authorises changes within the requested scope; native permission prompts still apply. The execution bridge depends on version-sensitive host behaviour and bypasses outer tool hooks, so compatibility with other plugins must be assessed separately.

Multiple workers consume model requests and context. Defaults allow four workers, two runs per project, 24 attempts per run, and 45 minutes of active run time. These are execution bounds, not a billing ceiling. GigaCode does not switch to a paid fallback model when your selected model is unavailable. Native title, summary, and compaction requests have their own host model settings.

Run state, artifacts, and exports live under the canonical project's `.gigacode/`. Exclude it from version control and review exports before sharing. Inspection redacts supported sensitive fields, but the trace is not private model reasoning or a complete replay of provider requests and native events.

Writers run serially by default. Optional isolated parallel writers require a clean committed Git root and support only disjoint plain UTF-8 additions and modifications. Keep external edits settled while integrating; see [workflow controls, persistence, and limits](https://github.com/expiracy/gigacode/blob/main/docs/commands.md) for the full restrictions and recovery behaviour. Model quality and feature parity with other products are not guaranteed.

## OpenChamber

OpenCode is the compatibility target. OpenChamber uses the same native plugin, agents, and settings; install into the profile used by its bundled supported OpenCode executable.

In OpenChamber 2.2.0, choose **GigaCode** and use conversational requests for work and inspection. Deterministic `/gigacode` results and the terminal settings/workflow dialogs have no desktop viewer there. Edit standard options through **Settings → Plugins → Options (JSON)**, or use `gigacode.json` for inheriting project overrides. See the [OpenChamber guide](https://github.com/expiracy/gigacode/blob/main/docs/configuration.md#openchamber-settings) for the tested scope and client limitations.

## Guides and development

- [Installation, updates, removal, and troubleshooting](https://github.com/expiracy/gigacode/blob/main/docs/installation.md)
- [Configuration and model selection](https://github.com/expiracy/gigacode/blob/main/docs/configuration.md)
- [Commands, recipes, recovery, and offline inspection](https://github.com/expiracy/gigacode/blob/main/docs/commands.md)
- [Development checks and the release checklist](https://github.com/expiracy/gigacode/blob/main/docs/development.md)
- [Alpha release notes](https://github.com/expiracy/gigacode/blob/main/CHANGELOG.md)
- [Architecture](https://github.com/expiracy/gigacode/blob/main/docs/architecture.md) and [workflow design](https://github.com/expiracy/gigacode/blob/main/docs/agent-workflows.md)

Run `bun run check:release` from the checkout for the local type, unit, and package checks. Native host compatibility has a separate matrix described in the development guide. Report problems through [GitHub issues](https://github.com/expiracy/gigacode/issues), including your Bun/OpenCode versions, operating system, and redacted error or run evidence.

Licensed under [MIT](https://github.com/expiracy/gigacode/blob/main/LICENSE).
