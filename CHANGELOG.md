# Changelog

## 0.1.0-alpha.1 — 2026-10-18

The first `opencode-gigacode` alpha uses npm tag `next` and an [MIT licence](LICENSE). Public guides are included in the npm package; the source repository remains private.

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

See [installation](docs/installation.md) for the alpha setup flow and [the README](README.md) for a first workflow.
