# Ultra workflow improvements

The user approved the five priorities discussed in chat on 13 October 2026. OpenCode remains the primary compatibility target, pinned to 2.0.25 and 2.0.26. Work happens in this checkout: it has no Git metadata, and a source baseline is saved at `/private/tmp/ultra-improvements-baseline`.

## Approach

Extend the existing validated graph engine, native sessions, permissions and evidence gates. A generated JavaScript runtime would duplicate the engine; a separate desktop extension would introduce another execution path. Native OpenCode UI and graph recipes provide the requested capabilities with smaller changes. No provider-specific routing or extra judging model is added.

## Evaluations and recipes

An opt-in evaluation runner attaches only to an explicitly selected loopback OpenCode endpoint, model and bounded budget. It creates isolated scratch projects and runs bugfix, feature, research, planning and interruption scenarios. Automatic checks establish code behavior, scope preservation and native evidence; prose quality is presented for human review, never inferred from keywords or model self-assessments. Reports retain unavailable usage as unknown and explain that accounting cannot guarantee a hard spending ceiling. Paid runs remain disabled until the user selects a model and budget.

Three reusable read-only recipes are deep review, bug investigation and cross-checked research. Each has independent investigation branches and an evidence-based synthesis. They use existing task fields and model settings. Explicit recipe selection cannot be combined with an authored graph or execute mode. Report-only completion does not manufacture a corrective execution proposal.

## Live visibility

The existing `/ultracode status` opens a live native searchable dialog, using the host's components. Show phase, task state, model/session, dependency and permission waits, accepted summaries, blockers, native checks and observed worker usage. Controls use the existing initiating-session ownership checks. Initial, reconnect and post-control reads reload durable snapshots; a non-overlapping two-second refresh runs only while the dialog is open. Navigation, replacement and disposal stop refreshes and ignore late responses. Configuration viewing remains at `/ultracode config`; no additional menus or slash commands are added.

## Context and usage

Expose observed worker usage without representing missing observations as zero. Bound the aggregate rendered task prompt with a configurable character budget, preserving the objective, immutable criteria and capabilities. Oversized dependency results become explicit references instead of silently truncated evidence. A read-only paginated tool retrieves only the immutable dependency results captured for the current bound attempt. Prompts and history record omitted content and retrieval. Fixed mandatory context that exceeds the budget refuses dispatch clearly. Existing saved runs without the new setting retain a default budget.

## Parallel writing

Parallel writing is explicitly opted into. Admission requires a clean committed canonical Git root without configured filters or submodules. Independent writers use isolated worktrees from the saved baseline; dependent writing/TDD sequences require serial mode. Project-wide execution ownership stays exclusive. The host's canonical project path owns shared state across native locations. Durable attempt checkout identities permit source recovery and destination permission/worker binding without weakening project/location checks.

Native source inspection found that `worktree.create` executes configured project startup commands without a worker permission check and offers no skip-startup contract. The delivered preparation task therefore uses a fixed generated Git command under its real native worker invocation, disables hooks, normalizes Git environment overrides, and refreshes native inventory. A tracked inert prompt activates destination hooks before releasing the actual task prompt. Native `session.wait` establishes quiescence rather than treating a move's previous idle stamp as the task's outcome.

After isolated writers settle, a serial root integration task applies captured changes through native tools under its genuine worker invocation and the original scope/permission rules. No unrestricted plugin filesystem copier or shell merge is introduced. Unsupported binary, mode, deletion, linked-file, omitted-manifest or overlapping changes fail closed and retain source worktrees. Retrying/resetting isolated writers requires a new run. Final independent review and native verification follow integration. Cancellation, ambiguous launches and conflicts retain reservations and artifacts until native settlement; no dirty worktree is force-removed. Native writes are not atomic against concurrent external edits during permission waits; that use remains unsupported. Actual native prelaunch placement must be demonstrated before claiming production support.

## Verification

Use Canon TDD for each new behavior. Keep the existing 346-test baseline green; add focused tests for authorization, stale/unknown evidence, lifecycle cleanup, bounded retrieval, recipe admission, evaluation scoring and isolated integration. Run TypeScript and regression tests, then isolated native scripted-provider checks. Native UI/source contracts and live paid-model quality have separate evidence scopes. Do not reload the user's client or modify their global installation.
