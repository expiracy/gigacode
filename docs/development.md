# Development and release preparation

[Back to README](../README.md) · [Installation](installation.md) · [Workflow commands](commands.md)

## Working from source

Requires Bun 1.3.10 or newer. Install dependencies without running lifecycle scripts:

```sh
bun install --frozen-lockfile --ignore-scripts
```

To register this checkout for development, use `bun run install:global`, or `bun run install:project --project /absolute/path/to/project`. The configuration points at this checkout; keep it at that path while registered. Packaged installations use the durable global package and `gigacode setup --global` instead.

## Release checklist

The candidate is `opencode-gigacode@0.1.0-alpha.1`, intended for npm's `next` tag. It remains unpublished and `private: true`. Preparation and execution evidence are separate:

| Item | State and evidence |
| --- | --- |
| Release boundary | Alpha version and `next` publishing configuration prepared; `private: true` still blocks publication. |
| Installation lifecycle | Local alpha.1 package smoke passed on macOS on 18 October 2026: external installation, doctor, explicit/repeated setup, same-version replacement in the same prefix, scoped deregistration, and npm removal preserved unrelated configuration and project state. This is a replacement rehearsal, not a version-to-version upgrade claim. Native matrix runs below also replaced the packed installation and restarted the host while preserving saved runs/events. |
| Local release gate | `TMPDIR=/private/tmp bun run check:release` passed on macOS with Bun 1.3.14 on 18 October 2026: typechecking, 640 tests, and the full package lifecycle smoke. The tarball contained 59 allowed files, including doctor, MIT licence, and alpha notes. |
| Native host matrix | `bun run test:integration` passed on macOS on 18 October 2026 for OpenCode 2.0.25, 2.0.26, and 2.0.28: 28 checks passed on each exact host, including packed same-prefix reinstall and native restart. Local report paths are listed below. |
| Parallel writers | `bun run test:parallel` passed on macOS/OpenCode 2.0.28 on 18 October 2026: two isolated writers, permission-checked preparation/integration, and fresh native verification succeeded. |
| Platform CI | Package jobs are defined for Ubuntu, macOS, and Windows; hosted results remain pending. Native host checks are a separate opt-in CI matrix. |
| Documentation | README, user guides, and [alpha notes](../CHANGELOG.md) prepared locally. The source repository is private: choose a public source/docs destination and update the links before npm release, then verify hosted links and GitHub/npm rendering. Repository visibility has not changed. |
| Licence | [MIT licence](../LICENSE) and `license: "MIT"` metadata are present and verified in the installed alpha.1 tarball. |
| Registry identity | Public registry lookup returned 404 for `opencode-gigacode` on 18 October 2026. No public entry was found; this does not reserve the name. Confirm availability and naming suitability again before release. |
| Publication | Withheld. Remove `private` only after the remaining checks and explicit publication authorisation. |

Record the exact candidate version, command, host/platform, and actual result when completing each pending check. The native suites use isolated profiles and a scripted model provider; optional real-model evaluations require explicit connection and budget arguments.

The 18 October native matrix reports are local, ignored evidence rather than hosted release artifacts:

- OpenCode 2.0.25: `.spike/integration-1792346941220-cc57bf40/integration.json` — 28 passed.
- OpenCode 2.0.26: `.spike/integration-1792346941568-6c300a77/integration.json` — 28 passed.
- OpenCode 2.0.28: `.spike/integration-1792346942211-fb58c495/integration.json` — 28 passed.

## Verification and source map

See [Agent coding architecture](architecture.md) for runtime boundaries, data ownership and extension points, and [Agent coding workflows](agent-workflows.md) for the request lifecycle, graph examples, verification and recovery.

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
| Installation and offline tools | `scripts/install.ts`, `scripts/cli.ts`, `scripts/doctor.ts` |

Completion decisions consume saved run snapshots without database or host access. Coordination depends on the `Store` interface; SQLite transactions and audit persistence remain in `store.ts`. Redaction is pure shared code used by persistence, reports and model-facing views. The native adapter retains command provenance and permission checks. Persisted state, RPC shapes and existing command entry points stay stable across these module boundaries.

Run the local release gate from the checkout:

```sh
bun run check:release
```

It runs `typecheck`, `test`, and `test:package` in order and stops on failure. It does not publish. Native compatibility and isolated parallel writing are separate checks:

```sh
bun run test:integration
bun run test:parallel
```

`test:package` packs the distributable and installs it without development dependencies into a temporary global prefix outside the checkout, including a path with spaces. It exercises the installed CLI and doctor, setup, preserved settings, and idempotence. It then overwrites the same prefix with the tarball and checks replacement and setup stability, followed by scoped manual deregistration and `npm uninstall`. Unrelated native configuration, customised agents/options, project state, and backups are checked for preservation. Registry access is required to install production dependencies; `PACKAGE_CHECK_OFFLINE=1` can use an existing npm cache selected with `npm_config_cache`. This check does not publish anything. On macOS, use a canonical temporary directory, such as `TMPDIR=/private/tmp`, for tests: runtime metadata deliberately rejects symlinked paths.

CI runs the local type/unit checks on Ubuntu and package checks on Ubuntu, macOS, and Windows. An explicit `workflow_dispatch` request with `native_host_checks` enabled runs the separate exact-host integration matrix. These definitions do not establish a passing hosted result until their jobs complete.

`test:parallel` uses a private scripted-provider host to exercise permission-checked Git preparation, actual moved native subagents, canonical shared state, exact integration and fresh root verification. It deliberately configures a native startup marker and asserts that the preparation path does not run it. Set `OPENCODE_SPIKE_BIN` to the matching installed host as for the production integration suite.

## Opt-in model evaluations

The evaluation runner attaches to an explicitly selected loopback OpenCode server and creates isolated scratch projects. It covers bug fixes, features, conflicting-source research, read-only planning and interruption after accepted predecessor work. Independent code oracles, file-scope checks and native evidence determine automatic results; the generated Markdown rubric leaves prose quality for human review. Reports retain failed attempts, cleanup failures and unavailable accounting.

```text
bun run test:evaluation --url http://127.0.0.1:4096 --model provider/model#variant --budget '{"attempts":12,"steps":12,"workerMs":60000,"runMs":180000}' --max-cost 1
```

Replace the endpoint/model with your connected host and set your own runtime bounds and observed-cost allowance. All four arguments are required before any connection or model prompt. `--scenario bugfix|feature|research|planning|interrupted` selects one fixture. Model settings and variants are checked before dispatch. `--max-cost` stops work at observed spend; in-flight and auxiliary requests can exceed that observation, so it is not a hard billing ceiling. Default unit tests and native scripted integration make no paid calls. This change supplies the harness; no new paid-model quality result is claimed.

The native integration suite installs the npm tarball outside the checkout, then uses the global installer with isolated configuration, homes, Git roots, databases, and a local scripted model provider, with no paid model calls. Its checks cover global availability, overrides and state isolation across two projects, command feedback, configuration RPC, scoped guided saves, advanced editing/reset compatibility and global reload/override behavior, production registration, plan and execution, role restrictions, native check provenance, export, restart, intents, cancellation, supervisor interruption and recovery, automatic mode, and unavailable models. The recovery check preserves accepted investigation, resumes a held dependent worker without duplicates, and confirms completion-notice delivery. GigaCode-mode checks cover ordinary configuration/status results, duplicate admission, saved-plan execution, ownership, forged child/Build calls, and selection changes before admission. The [latest validation record](https://github.com/expiracy/gigacode/blob/main/docs/design.md#change-installed-gpt-validation--opencode-2028-and-live-workflows) records installation, terminal checks, real GPT outcomes and limits. Evidence and logs remain under `.spike/integration-<timestamp>-<id>/`.

`bun run spike` reproduces the earlier 22-probe host compatibility matrix and requires Git. Set `OPENCODE_SPIKE_BIN` if the matching executable is outside the normal Windows npm location or `PATH`.

Set `OPENCODE_TEST_VERSION=2.0.26` or `2.0.28` together with its matching `OPENCODE_SPIKE_BIN` to run the spike or production integration suite against that host. The default remains 2.0.25. For the optional OpenChamber settings integration, point `OPENCHAMBER_SOURCE` at an OpenChamber source checkout with its dependencies installed, then run `bun run test:openchamber`. This exercises OpenChamber's real plugin-settings reader/writer against an isolated OpenCode host; it does not render the OpenChamber UI.

## Further reading

- [Design and implementation record](https://github.com/expiracy/gigacode/blob/main/docs/design.md): decisions, architecture, lifecycle, and remaining scope.
- [Research notes](https://github.com/expiracy/gigacode/blob/main/docs/research.md): upstream behaviour and primary sources.
- [Compatibility results](https://github.com/expiracy/gigacode/blob/main/docs/compatibility-spike.md): reproducible host probes and version-sensitive contracts.
- [Offline CLI](commands.md#offline-cli): validation, prompt rendering, saved state and exports.
