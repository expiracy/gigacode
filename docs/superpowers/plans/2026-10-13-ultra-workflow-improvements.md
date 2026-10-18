# GigaCode Workflow Improvements Implementation Plan

**Historical plan, 13 October 2026. Current contract, 15 October 2026:** GigaCode requires fresh configuration and state using current GigaCode identifiers, `gigacode.json` and `.gigacode/`. Earlier products' settings, permission identifiers, prompts and histories are not imported, and their files remain untouched. Native OpenCode permissions remain enforced. This plan records the original work and environment; follow the [current installation guide](../../../README.md) for setup.

> **For agentic workers:** Use superpowers:subagent-driven-development. Check off delivered behaviors after their focused tests and review.

**Goal:** Add measurable model evaluations, live progress, bounded context, reusable recipes and safely isolated parallel writing to the existing GigaCode engine.

**Architecture:** Reuse graph admission, native sessions, permission-preserving tools and durable state. Keep client rendering separate from scheduling. Independent implementers own distinct files; the parent integrates shared schema/plugin changes.

**Tech Stack:** Bun, TypeScript, Effect, SQLite, native OpenCode plugin/RPC/TUI APIs, Solid.

**Spec:** `docs/superpowers/specs/2026-10-13-ultra-workflow-improvements-design.md`

## Global constraints

- OpenCode 2.0.25 and 2.0.26; Bun >=1.3.10. No added dependencies.
- Preserve native asks/denies, immutable criteria, scoped writing and fresh independent review/check evidence.
- No paid runs without explicit model and budget; no user profile writes or client reloads.
- No Git metadata exists here. Review against `/private/tmp/ultra-improvements-baseline`; do not create a repository.
- Write one failing behavior test, observe the intended failure, implement minimally and rerun relevant regressions.

## Tasks

- [x] Restore locked dependencies; establish TypeScript and 346 passing test baseline with private localhost fixtures.
- [x] Visibility: implement `src/workflow-view.ts`, native live dialog in `tui.ts`, projection/lifecycle tests; parent integrates workflow RPC.
- [x] Evaluations: implement guarded `tests/model-evaluation.ts`, scenario fixtures and scorer/argument tests; parent adds package entry and docs.
- [x] Recipes: implement `src/recipes.ts`, command/tool/offline preview contracts and tests; parent integrates durable metadata/report completion.
- [x] Parallel writing: implement native worktree management, durable checkout/prelaunch/recovery/integration behavior in `src/worktrees.ts`, `src/engine.ts`, `src/opencode.ts` and focused tests; parent integrates shared types/config/plugin tool.
- [x] Context: implement aggregate prompt budget and captured dependency references/retrieval; extend config/tool/policy contracts and tests without dropping immutable instructions.
- [x] Integrate shared interfaces and documentation; review each task's concrete diff and assertions.
- [x] Run TypeScript, unit/fixture regression tests, isolated native checks and focused failure-boundary probes. Record unsupported/native/paid evaluation limits accurately.
- [x] Obtain independent final review; fix actionable issues and deliver the verified changes.

Final verification: TypeScript passes; 452 tests pass with 2,521 assertions and zero failures. All 22 production native checks and the parallel/startup-skip/native-denial fixture pass on macOS/OpenCode 2.0.25, against frozen source hash `b270e5fa582e54e90d31d5d4910fcc7dfc86500566a28fac062507dc6bec37f5`. Native reports are `.spike/integration-1791916193115-869d393b/integration.json` and `.spike/parallel-2.0.25-1791916190612-01c0f70a/result.json`. Independent final review is clean. No paid evaluation, current native 2.0.26 rerun, actual live-dialog terminal rendering, global installation or user-client reload was performed.
