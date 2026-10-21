# Changelog

## 0.1.0 — Unreleased

- Prepare the first stable release for npm `latest`, keeping existing prerelease tags and versions unchanged. Publication and the GitHub release remain subject to human approval.
- Validate stable semantic versions throughout artifact preparation and registry verification; retain alpha/beta delivery on `next` and mark stable GitHub drafts as normal releases.
- Include automatic GigaCode agent workflows, optional explicit planning, native settings and workflow popups, bounded error notifications, and the tested global installation lifecycle from the published beta.
- Retain the exact supported OpenCode host versions, runtime requirements, permission behavior, limits, and CI artifact checks. A stable package version does not expand host support or erase the documented limitations.

## 0.1.0-beta.3 — Unreleased

- Correct GitHub release-asset HTTP framing by sending the exact verified byte length. A real local HTTP test exercises the installed GitHub CLI with binary and Unicode bytes.
- Prepare a fresh tagged candidate after the previous Actions run created immutable `v0.1.0-beta.2` and a partial draft before its upload failed. That tag remains unchanged; the previous candidate has not been published to npm.

## 0.1.0-beta.2 — Unreleased

- Add a manual **Publish npm package** workflow: rehearsal by default, direct OIDC publication after required human approval in the protected `npm-production` GitHub environment.
- Require the immutable version tag to identify the exact source commit, publish the CI-tested tarball without repacking or lifecycle scripts, and verify public registry integrity with provenance enabled.
- Retain the separate npm staging path. `0.1.0-beta.1` was published from its OIDC stage on 20 October 2026; this fresh version keeps that published version immutable.

## 0.1.0-beta.1 — 2026-10-20

- Clarify automatic implementation in the GigaCode agent and optional explicit planning; shorten the README and add Ko-fi support links.
- Show bounded, redacted native error notifications when settings, workflow, or command viewers cannot open; suppress normal cancellation and stale-dialog notifications.
- Add a manual GitHub release rehearsal and draft action with immutable version tags and the exact CI-tested package, metadata, and checksums. Human publication remains separate.

Published to npm under `next` after human approval of the CI-tested OIDC stage. The public archive matches the staged bytes; all 10 production installation/lifecycle checks and 28 native checks passed on macOS with OpenCode 2.0.28. See the [beta release verification](docs/development.md#published-beta1-verification). The source repository, guides, and product images are public.

- Updated candidate version and installation/documentation links to `0.1.0-beta.1`.
- Added workflow and settings screenshots from an isolated native example, with a product overview, beta-channel quickstart, and capture provenance.
- Added the GigaCode logo and full application captures with GigaCode selected, including the workflow and settings popups in context.
- Fixed a recovery race that could reject a valid worker while ownership moved to a replacement supervisor.
- Added automatic type/unit/workflow checks, package lifecycle checks on three platforms, native host checks, and a manual exact-artifact release rehearsal. OIDC staging requires an explicit manual request and configured npm trust; final publication requires human npm approval; pushes and tags cannot publish.
- Retained the workflow controls, explicit setup, doctor diagnostics, requirements, and limitations described in the alpha baseline below.

## 0.1.0-alpha.1 — 2026-10-18

The first `opencode-gigacode` alpha was published under npm tag `next` on 18 October 2026 with an [MIT licence](LICENSE). Its validation results are historical evidence, not beta verification. Guides are included in the package artifact; the source repository is now public.

### Included

- Plan-only discovery and saved proposals, with explicit execution of an exact saved revision after workspace freshness checks.
- Native multi-agent workflows with inspectable prompts, model choices, worker sessions, attempts, command evidence, recovery, and bounded repair.
- A terminal workflow control panel at `/gigacode status`: select a workflow, open its Actions menu, inspect saved pages, run a ready proposal, export reports, pause, resume, cancel, or open a native worker session. Settings remain separate at `/gigacode config`.
- Guided project/global configuration, inherited model settings, project-specific checks, and evidence-based completion. A model's test claim cannot replace native command evidence.
- Durable global installation through npm, explicit `gigacode setup`, and local `gigacode doctor` diagnostics with human-readable or JSON output.
- Release checks for the production tarball's install, same-prefix replacement, setup, and removal lifecycle; separate native integration and platform CI matrices. These are check capabilities, not a claim that the current candidate has passed every matrix.

### Requirements and limits

- Bun 1.3.10 or newer is required at runtime. Only OpenCode 2.0.25, 2.0.26, and 2.0.28 are accepted. A connected model with tool support is needed for workflows.
- OpenCode's version-sensitive native bridge retains permission checks but bypasses outer tool hooks; compatibility with other plugins needs separate assessment.
- OpenChamber 2.2.0 supports conversational GigaCode use but has no viewer for deterministic command results or the terminal control/settings panels.
- Workers consume model requests and context. Execution limits are not billing ceilings; model quality and feature parity with other products are not guaranteed.
- Writers are serial by default. Optional isolated parallel writing requires a clean committed Git root and is limited to disjoint plain UTF-8 additions/modifications; see the [full restrictions](docs/commands.md#persistence-and-limits).
- Run state and exports live under the canonical project's `.gigacode/`. Inspection is bounded; exported redacted audits retain history, but neither provides private model reasoning or a complete provider/native-event replay.

See [installation](docs/installation.md) for the current candidate's setup flow and [the README](README.md) for a first workflow.
