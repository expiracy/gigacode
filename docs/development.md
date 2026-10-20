# Development and release preparation

[Back to README](../README.md) · [Installation](installation.md) · [Workflow commands](commands.md)

## Working from source

The [source repository](https://github.com/expiracy/gigacode) is public. These contributor checks require a source checkout; tests and research history are not shipped in the npm package. Requires Bun 1.3.10 or newer. Install dependencies without running lifecycle scripts:

```sh
bun install --frozen-lockfile --ignore-scripts
```

To register this checkout for development, use `bun run install:global`, or `bun run install:project --project /absolute/path/to/project`. The configuration points at this checkout; keep it at that path while registered. Packaged installations use the durable global package and `gigacode setup --global` instead.

To rehearse the distributable locally, create an output directory outside the checkout and use its absolute path:

```sh
npm pack --ignore-scripts --pack-destination /absolute/path/to/release-artifacts
npm install --global /absolute/path/to/release-artifacts/opencode-gigacode-0.1.0-beta.3.tgz
gigacode setup --global
```

This installs the local artifact without publishing it. Use an isolated profile when rehearsing setup, upgrades, and removal.

Delivery-helper tests run separately with `node --test tests/*.test.mjs` and
require GitHub CLI (`gh`) on `PATH`. The HTTP regression uses isolated configuration,
a dummy token, and a loopback server; it does not require a GitHub sign-in.

## Release checklist

This checkout prepares `opencode-gigacode@0.1.0-beta.3` for direct OIDC publication through GitHub Actions after required human approval. The earlier `v0.1.0-beta.2` tag identifies the failed draft-upload candidate and remains unchanged; the next version includes its HTTP upload fix. `0.1.0-beta.1` was submitted through npm OIDC staging on 20 October 2026 and remains a separate, reserved candidate. The fresh version includes those product and error-feedback changes plus the new publication path. The source repository and guides are public; consult npm and the changelog for actual publication status.

### Prior alpha validation

The evidence below belongs to `0.1.0-alpha.1` from 18 October 2026. It is historical validation and must not be relabelled as a passing beta gate. Consult the [npm listing](https://www.npmjs.com/package/opencode-gigacode) for current registry status.

| Item | State and evidence |
| --- | --- |
| Release boundary | Alpha version and `next` publishing configuration prepared on 18 October 2026, when the source repository was private. The repository is now public. |
| Installation lifecycle | Local alpha.1 package smoke passed on macOS on 18 October 2026: external installation, doctor, explicit/repeated setup, same-version replacement in the same prefix, scoped deregistration, and npm removal preserved unrelated configuration and project state. This is a replacement rehearsal, not a version-to-version upgrade claim. Native matrix runs below also replaced the packed installation and restarted the host while preserving saved runs/events. |
| Local release gate | `TMPDIR=/private/tmp bun run check:release` passed on macOS with Bun 1.3.14 on 18 October 2026: typechecking, 642 tests, and the full package lifecycle smoke. The tarball contained 59 allowed files, including doctor, MIT licence, and alpha notes. |
| Native host matrix | `bun run test:integration` passed on macOS on 18 October 2026 for OpenCode 2.0.25, 2.0.26, and 2.0.28: 28 checks passed on each exact host, including packed same-prefix reinstall and native restart. Local report paths are listed below. |
| Parallel writers | `bun run test:parallel` passed on macOS/OpenCode 2.0.28 on 18 October 2026: two isolated writers, permission-checked preparation/integration, and fresh native verification succeeded. |
| Platform CI | Internal hosted CI run `39154548724` passed on 18 October 2026 for code commit `da7b936`: Ubuntu type/unit checks and the full package lifecycle on Ubuntu, macOS, and Windows. The separate opt-in native CI matrix was skipped; the native results above are local macOS runs. |
| Documentation | The alpha preparation on 18 October 2026 selected the guides, README, licence, and changelog for the npm package, with version-pinned jsDelivr URLs. That snapshot did not verify CDN retrieval or npm rendering after upload. The source repository was private at that time and is now public. |
| Licence | [MIT licence](../LICENSE) and `license: "MIT"` metadata are present and verified in the installed alpha.1 tarball. |
| Registry identity | Public registry lookup returned 404 for `opencode-gigacode` on 18 October 2026 before upload. This historical lookup does not reserve the name or establish current registry status. |
| Review | Reviewed on PR #1 from `codex/release-prep-alpha` during the private-repository alpha preparation on 18 October 2026. |
| Publishing access | `npm whoami` authenticated as `expiracy` on 18 October 2026. Authentication alone does not establish publication success. |
| Publication | The registry records alpha.1 publication at 19:50 UTC on 18 October 2026. As of the 20 October beta preparation, beta.1 remains unpublished and the existing `next` tag is unchanged. |

Record the exact candidate version, command, host/platform, and actual result when reproducing these checks. The native suites use isolated profiles and a scripted model provider; optional real-model evaluations require explicit connection and budget arguments.

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

The reusable `ci.yml` runs automatically on pull requests and pushes to `main`, and can also be dispatched manually. It checks types, unit tests, workflow lint, the package lifecycle on Ubuntu/macOS/Windows, all three exact native hosts on Ubuntu, and isolated parallel writers on Ubuntu/2.0.28. Its aggregate job is named **CI**. Actions are pinned to commit SHAs; Dependabot checks action updates weekly. A workflow definition alone does not establish a passing beta result; retain the run and commit with its actual outcomes.

`test:parallel` uses a private scripted-provider host to exercise permission-checked Git preparation, actual moved native subagents, canonical shared state, exact integration and fresh root verification. It deliberately configures a native startup marker and asserts that the preparation path does not run it. Set `OPENCODE_SPIKE_BIN` to the matching installed host as for the production integration suite.

## CI and controlled release rehearsals

The manual workflow **Prepare npm release** (`release.yml`) reuses those checks and defaults to an artifact rehearsal. Its required `version` input must exactly match `package.json` on `main`; the optional Boolean `stage` defaults to `false`. Once the reviewed workflow is available on `main`, run:

```sh
gh workflow run release.yml --ref main -f version=0.1.0-beta.3 -F stage=false
```

This builds one tarball, runs its installed-package lifecycle checks, and retains the exact tarball with `release.json` as `npm-package-<commit>-<run-attempt>` for 30 days. The manifest binds the package version and `next` tag to the full source commit, SHA-512 integrity, SHA-1 checksum, size, file count, and runtime versions. Native/parallel diagnostic artifacts are retained for seven days. Rehearsal does not change npm registry state. Pushes and tags cannot automatically stage or publish a package.

From a clean, committed authorised source checkout, use an empty output directory outside the checkout for a local rehearsal:

```sh
bun run scripts/release-artifact.ts prepare /absolute/path/to/release-artifacts 0.1.0-beta.3
bun run scripts/release-artifact.ts verify /absolute/path/to/release-artifacts 0.1.0-beta.3 <full-commit-sha>
bun run scripts/check-package.ts --artifact /absolute/path/to/release-artifacts/opencode-gigacode-0.1.0-beta.3.tgz
```

Replace the paths and commit placeholder with the intended output directory and exact 40-character commit. `prepare` packs once and validates package/docs metadata; `verify` checks the retained bytes and metadata without repacking or publishing. The final command exercises that artifact's installed-package lifecycle. A future staging action must use the verified artifact rather than building another tarball.

The `main` branch requires an up-to-date pull request with a passing aggregate **CI** result from GitHub Actions, including for administrators. Force pushes and branch deletion are disabled. The PR gate requires no extra review for this single-maintainer repository; direct production publication has a separate required human deployment approval.

One-time npm trusted-publisher setup remains a maintainer step. Configure it for this GitHub repository, workflow `release.yml`, and environment `npm`. Under **Allowed actions**, permit `npm stage publish` only; leave direct `npm publish` and `npm dist-tag` disabled. Configure the GitHub `npm` environment and, where supported, its protection rules. A rehearsal does not change npm account security or publisher settings. The source repository is public; registry staging still requires its own configured trusted publisher.

When staging is explicitly requested, run the workflow with `stage=true`. Its stage job runs directly in `release.yml`, uses Node 24/npm 11.16.0 and OIDC, re-verifies the downloaded artifact, keeps npm provenance disabled in the current workflow configuration, and submits that exact tarball to npm staging under `next`. It records a staging receipt; it does not finish publication. Final npm stage approval requires a human with 2FA. A GitHub environment is a human gate only when its required-reviewer protections are configured. This staging workflow has no direct npm publication path; the separate production workflow below provides it. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for maintainer setup.

### GitHub draft releases

The manual workflow **Prepare GitHub release** (`github-release.yml`) prepares a draft for the version in the selected source commit. In GitHub, open **Actions → Prepare GitHub release → Run workflow**, choose `main`, and leave `delivery` at `rehearsal`. It runs the reusable CI gate and downloads the single artifact tested by that run. It verifies the tarball against its original `release.json`, then generates release notes and `SHA256SUMS`. The equivalent CLI request is:

```sh
gh workflow run github-release.yml --ref main -f delivery=rehearsal
```

The rehearsal generates local evidence without calling GitHub's release API. Its sanitized diagnostics, `RELEASE_NOTES.md`, and `SHA256SUMS` are retained for 14 days; the original tarball and manifest remain in the CI artifact for 30 days. Download those artifacts to inspect the exact candidate before requesting a draft.

When you intend to create the version tag and draft, use the same screen with `delivery` set to `draft`, or run:

```sh
gh workflow run github-release.yml --ref main -f delivery=draft
```

Draft creation requires the protected `main` branch of `expiracy/gigacode` and a passing CI run in that invocation. Only the draft job receives repository write permission. It prepares a draft for `v<package-version>` with the verified tarball, original manifest, and `SHA256SUMS` as assets. A repeated request can finish missing assets on a matching draft; conflicting assets or an already published release fail without replacement. A maintainer must review and publish the draft manually. This workflow does not change npm staging or publication.

### Direct npm publication from GitHub Actions

**Publish npm package** (`publish.yml`) defaults to rehearsal. Explicit direct
publication waits for human approval in **npm-production** after all checks pass.
The workflow uses the one exact CI-tested tarball, verifies source/version/MIT
licence/integrity, and publishes through OIDC with provenance enabled and
lifecycle scripts disabled. It never approves npm stages or substitutes tokens.

One-time setup:

- GitHub environment **npm-production**: required reviewer **expiracy**,
  administrator bypass disabled, and branch **main** only. Allow this solo
  maintainer to approve their own dispatched run; approval is still a deliberate
  human action in GitHub.
- A separate npm trusted publisher for `expiracy/gigacode`, workflow
  **publish.yml**, environment **npm-production**, permitting direct publish.
  Keep `release.yml` / `npm` stage-only. No npm secret or standalone dist-tag
  permission is needed.

```sh
npm trust github opencode-gigacode \
  --repository=expiracy/gigacode --file=publish.yml \
  --environment=npm-production --allow-publish
```

The production npm binding is not yet configured. Create it when a future
release is ready; npm requires its first successful publish within two days.

The GitHub production environment was configured with these rules on 20 October
2026. Recheck live required reviewers, disabled bypass, and exact branch policy;
writing an environment name in YAML alone does not configure a human gate.

Release sequence:

1. Merge an unused version and release notes through the required CI gate.
2. Run **Prepare GitHub release** with `delivery=draft` to create immutable
   `v<version>` and a reviewable draft package at that source commit.
3. Run **Publish npm package** in rehearsal mode and inspect its recorded source,
   version, channel, integrity, and diagnostics.
4. Request `delivery=publish`; after CI passes, inspect **Review deployments** and
   approve the concrete `npm-production` deployment in GitHub.
5. Verify the public exact-version integrity, installed package and native host
   behavior, and npm provenance. Review/publish the GitHub draft separately.

```sh
gh workflow run publish.yml --ref main -f version=0.1.0-beta.3 -f delivery=rehearsal
gh workflow run publish.yml --ref main -f version=0.1.0-beta.3 -f delivery=publish
```

The production job requires protected upstream `main`, an explicit request and
matching existing version tag, and rejects legacy credentials. Registry errors
fail closed. A previously published version is a successful rerun only if its
integrity and intended channel still match; reruns do not overwrite versions or
move tags. `next` does not automatically become `latest`.

The final deployment approval belongs to a human. Do not approve or bypass it
through an automated API call. Existing npm stages share the same version
namespace and must follow npm's human 2FA approval path; use fresh versions for
this direct-publication path.

## Opt-in model evaluations

The evaluation runner attaches to an explicitly selected loopback OpenCode server and creates isolated scratch projects. It covers bug fixes, features, conflicting-source research, read-only planning and interruption after accepted predecessor work. Independent code oracles, file-scope checks and native evidence determine automatic results; the generated Markdown rubric leaves prose quality for human review. Reports retain failed attempts, cleanup failures and unavailable accounting.

```text
bun run test:evaluation --url http://127.0.0.1:4096 --model provider/model#variant --budget '{"attempts":12,"steps":12,"workerMs":60000,"runMs":180000}' --max-cost 1
```

Replace the endpoint/model with your connected host and set your own runtime bounds and observed-cost allowance. All four arguments are required before any connection or model prompt. `--scenario bugfix|feature|research|planning|interrupted` selects one fixture. Model settings and variants are checked before dispatch. `--max-cost` stops work at observed spend; in-flight and auxiliary requests can exceed that observation, so it is not a hard billing ceiling. Default unit tests and native scripted integration make no paid calls. This change supplies the harness; no new paid-model quality result is claimed.

The native integration suite installs the npm tarball outside the checkout, then uses the global installer with isolated configuration, homes, Git roots, databases, and a local scripted model provider, with no paid model calls. Its checks cover global availability, overrides and state isolation across two projects, command feedback, configuration RPC, scoped guided saves, advanced editing/reset compatibility and global reload/override behavior, production registration, plan and execution, role restrictions, native check provenance, export, restart, intents, cancellation, supervisor interruption and recovery, automatic mode, and unavailable models. The recovery check preserves accepted investigation, resumes a held dependent worker without duplicates, and confirms completion-notice delivery. GigaCode-mode checks cover ordinary configuration/status results, duplicate admission, saved-plan execution, ownership, forged child/Build calls, and selection changes before admission. The release evidence above distinguishes scripted native checks from model-quality evaluation. Local development evidence and logs remain under `.spike/integration-<timestamp>-<id>/`.

`bun run spike` reproduces the earlier 22-probe host compatibility matrix and requires Git. Set `OPENCODE_SPIKE_BIN` if the matching executable is outside the normal Windows npm location or `PATH`.

Set `OPENCODE_TEST_VERSION=2.0.26` or `2.0.28` together with its matching `OPENCODE_SPIKE_BIN` to run the spike or production integration suite against that host. The default remains 2.0.25. For the optional OpenChamber settings integration, point `OPENCHAMBER_SOURCE` at an OpenChamber source checkout with its dependencies installed, then run `bun run test:openchamber`. This exercises OpenChamber's real plugin-settings reader/writer against an isolated OpenCode host; it does not render the OpenChamber UI.

## Further reading

- [Architecture](architecture.md): runtime boundaries, data ownership, and extension points.
- [Workflow design](agent-workflows.md): graph examples, verification, and recovery.
- Design, research, and compatibility histories are available in the public source repository and are not part of the published package.
- [Offline CLI](commands.md#offline-cli): validation, prompt rendering, saved state and exports.
