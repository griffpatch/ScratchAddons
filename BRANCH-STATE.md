# Branch and PR State

Snapshot date: 2026-07-04

## Summary

- `dev` has been recreated from `upstream/master` on 2026-07-04.
- Pre-rebuild `dev` is preserved as `dev-legacy-2026-07-04`.
- GitHub CLI shows `9` open PRs from your branches in `ScratchAddons/ScratchAddons`.
- The inspector/AI/differ stack has now been split to `feature/scratch-project-inspector-differ` (created from `upstream/master`, 8 commits applied).
- The Finder/find-bar stack has now been applied to `feature/find-bar-v2` (remaining unique commit cherry-picked from `dev`).
- `feature/find-bar-extensions` has been deleted locally and on `origin` after confirming `feature/find-bar-v2` as canonical.
- Known dev-only stacks listed in this document are now split out.

## Feature Branch PR Matrix (2026-07-04)

Legend:

- `Last commit` is branch tip date.
- `PR updated` helps show whether review activity is stale.
- `Action` is a triage suggestion, not an automatic delete/close instruction.

| Branch | Last commit | Remote branch | PR | PR updated | Action |
|---|---:|---|---|---:|---|
| `parked/custom-menu-bar` | 2026-03-28 | yes | none | - | Parked on 2026-07-04; keep for later triage before opening a PR. |
| `feature/custom-zoom` | 2026-03-28 | yes | [#8919](https://github.com/ScratchAddons/ScratchAddons/pull/8919) open | 2026-04-30 | Old open PR; rebase/refresh or close as superseded. |
| `feature/editor-cleanup-plus-fixes` | 2026-05-09 | no | none | - | Likely superseded by live-cleanup/fixes-pr branches; keep only if it has unique commits you still want. |
| `feature/editor-cleanup-plus-fixes-pr` | 2026-05-24 | yes | [#9024](https://github.com/ScratchAddons/ScratchAddons/pull/9024) open | 2026-05-27 | Keep as the PR branch for this stack. |
| `feature/editor-cleanup-plus-live-cleanup` | 2026-05-24 | yes | none | - | Contains `feature/editor-cleanup-plus-fixes-pr`; decide whether to open separate PR or fold into #9024. |
| `feature/find-bar-v2` | 2026-07-04 | yes | none | - | Active branch to keep (canonical finder branch; includes split `dev` follow-up commit). |
| `feature/middle-click-popup-visual-query-enhancements` | 2026-05-16 | no | none | - | Follow-up branch with visual/query improvements beyond undo-fix PR scope; keep for possible second PR. |
| `feature/middle-click-popup-undo-fix` | 2026-05-16 | yes | [#9029](https://github.com/ScratchAddons/ScratchAddons/pull/9029) open | 2026-05-19 | Canonical current PR branch for the narrow undo fix. |
| `feature/paint-boolean-ops` | 2026-06-06 | yes | [#8917](https://github.com/ScratchAddons/ScratchAddons/pull/8917) open | 2026-06-22 | Active-ish open PR; keep and continue updating there. |
| `feature/paint-canvas-pan` | 2026-03-29 | yes | [#8913](https://github.com/ScratchAddons/ScratchAddons/pull/8913) open | 2026-03-29 | Very stale open PR; likely needs refresh or closure decision. |
| `feature/paint-gradient-editor` | 2026-07-03 | yes | [#8918](https://github.com/ScratchAddons/ScratchAddons/pull/8918) open | 2026-07-03 | Active and recently updated; keep as current working PR branch. |
| `feature/paint-rig-tool` | 2026-04-18 | no | none | - | Active branch to keep; PR intentionally deferred for now. |
| `feature/paint-round-corners` | 2026-07-03 | yes | [#8916](https://github.com/ScratchAddons/ScratchAddons/pull/8916) open | 2026-07-03 | Active and recently updated; keep as current working PR branch. |
| `feature/paint-round-corners-reshape-overlay` | 2026-07-03 | no | none | - | Retired on 2026-07-04 after confirming `feature/paint-round-corners` as canonical. |
| `feature/paint-stroke-options` | 2026-07-03 | yes | [#8914](https://github.com/ScratchAddons/ScratchAddons/pull/8914) open | 2026-07-03 | Active and recently updated; keep as current working PR branch. |
| `feature/spritesheet-import` | 2026-04-20 | no | none | - | Active branch to keep; PR intentionally deferred for now. |
| `feature/swap-local-global-multi-sprite-conversion` | 2026-06-17 | no | none | - | Retired on 2026-07-04 after confirming `pr/swap-local-global` as canonical PR branch. |
| `fix/new-blockly-compat` | 2026-05-10 | no | none | - | Retired on 2026-07-04 (fix is present in `upstream/master`). |
| `pr/swap-local-global` | 2026-06-17 | yes | [#9075](https://github.com/ScratchAddons/ScratchAddons/pull/9075) open | 2026-06-30 | Active PR branch; keep. |

## Open PRs Found (ScratchAddons/ScratchAddons)

- [#9075](https://github.com/ScratchAddons/ScratchAddons/pull/9075) `pr/swap-local-global` (open, updated 2026-06-30)
- [#9029](https://github.com/ScratchAddons/ScratchAddons/pull/9029) `feature/middle-click-popup-undo-fix` (open, updated 2026-05-19)
- [#9024](https://github.com/ScratchAddons/ScratchAddons/pull/9024) `feature/editor-cleanup-plus-fixes-pr` (open, updated 2026-05-27)
- [#8919](https://github.com/ScratchAddons/ScratchAddons/pull/8919) `feature/custom-zoom` (open, updated 2026-04-30)
- [#8918](https://github.com/ScratchAddons/ScratchAddons/pull/8918) `feature/paint-gradient-editor` (open, updated 2026-07-03)
- [#8917](https://github.com/ScratchAddons/ScratchAddons/pull/8917) `feature/paint-boolean-ops` (open, updated 2026-06-22)
- [#8916](https://github.com/ScratchAddons/ScratchAddons/pull/8916) `feature/paint-round-corners` (open, updated 2026-07-03)
- [#8914](https://github.com/ScratchAddons/ScratchAddons/pull/8914) `feature/paint-stroke-options` (open, updated 2026-07-03)
- [#8913](https://github.com/ScratchAddons/ScratchAddons/pull/8913) `feature/paint-canvas-pan` (open, updated 2026-03-29)

## Local Branch Inventory

### Integration and baseline branches

- `dev` — main working branch for the current integration stack.
- `master` — local backup branch with mixed work; currently `49` commits ahead of `upstream/master`.
- `personal/base` — personal baseline branch with the addon dev notes.

### Already isolated feature branches

- `feature/scratch-project-inspector-differ` — isolated inspector/AI/differ stack split from `dev` on 2026-07-04.
- `parked/custom-menu-bar` — hide full menu bar option (parked).
- `feature/custom-zoom` — custom zoom changes.
- `feature/editor-cleanup-plus-fixes` — editor cleanup and spacing fixes.
- `feature/editor-cleanup-plus-fixes-pr` — follow-up cleanup fixes.
- `feature/editor-cleanup-plus-live-cleanup` — live cleanup reliability and spacing work.
- `feature/find-bar-v2` — find-bar follow-up around middle-click behavior.
- `feature/middle-click-popup-visual-query-enhancements` — middle-click popup visual/query enhancements.
- `feature/middle-click-popup-undo-fix` — undo coalescing fix.
- `feature/paint-boolean-ops` — boolean ops work for Paint.
- `feature/paint-canvas-pan` — paint canvas pan/zoom work.
- `feature/paint-gradient-editor` — gradient editor work.
- `feature/paint-rig-tool` — vector costume editor rig tool.
- `feature/paint-round-corners` — round-corners addon.
- `feature/paint-stroke-options` — stroke cap/join options.
- `feature/spritesheet-import` — spritesheet import addon.
- `pr/swap-local-global` — PR-style branch for swap-local-global work.

## Dev-Only Stacks To Split Out

Status update: the inspector/AI/differ stack was split out on 2026-07-04.

### Inspector / AI / differ stack (completed)

- New branch: `feature/scratch-project-inspector-differ`
- Base: `upstream/master`
- Applied commits: `00529095`, `80becfe0`, `da0fa257`, `5cfdcc11`, `e7f41783`, `d9001258`, `7526e040`, `69434c0f`
- Current branch tip after split: `61a03cf5` (`Differ - params`)
- Result: this stack is no longer pending as dev-only work.

### Finder / find-bar stack

- Canonical branch: `feature/find-bar-v2`
- `95ed1023` was already patch-equivalent in `feature/find-bar-v2`.
- `29961830` was cherry-picked from `dev` into `feature/find-bar-v2` on 2026-07-04.
- Current branch tip after split: `ac898a06` (`find-bar: add click-triggered info panel with filter and instances tables`).
- Result: this stack is no longer pending as dev-only work.

Finder lineage check (2026-07-04):

- `dev` most closely follows the `feature/find-bar-v2` line (patch-equivalent chain present there).
- Former branch `feature/find-bar-extensions` was an older/squashed sibling and has now been removed.
- Relative to `feature/find-bar-v2`, commit `95ed1023` is patch-equivalent already, while `29961830` is still unique on `dev`.

## Confirmed Branch Relationships

### Clearly included in a larger branch

- `feature/middle-click-popup-undo-fix` is included in `feature/middle-click-popup-visual-query-enhancements`.
- `feature/paint-round-corners-reshape-overlay` is included in `feature/paint-round-corners`.
- `feature/editor-cleanup-plus-fixes-pr` is included in `feature/editor-cleanup-plus-live-cleanup`.

### Already merged into `dev`

- `fix/new-blockly-compat` is present in `upstream/master` (and was also merged into `dev`).

### Related but not simple parent/child copies

- `feature/editor-cleanup-plus-fixes` and `feature/editor-cleanup-plus-live-cleanup` are also diverged siblings rather than a direct parent/child pair.

## Notes

- I treated your “Finder” work as the `find-bar` stack, since that is the addon name used in the commit history.
- GitLens Launchpad did not surface these PRs, but GitHub CLI did. For this repository, GitHub CLI is the reliable source for PR mapping.
- If you want to keep tidying this up, the next useful step is to assign the inspector / AI stack and the find-bar follow-up stack to their own feature branches or PR branches.

## Inferred Intent (for your confirmation)

This is my best read of what you were trying to do, based on naming, ancestry, and dates.

| Branch or family | Evidence | Likely intent | Confidence |
|---|---|---|---|
| `pr/swap-local-global` vs `feature/swap-local-global-multi-sprite-conversion` | `pr/*` has open PR #9075; `feature/*` has very large unique history (`onlyA=115`, `onlyB=6`) | `pr/*` is the review branch; `feature/*` is a broader development branch | High |
| `feature/editor-cleanup-plus-fixes-pr` vs `feature/editor-cleanup-plus-live-cleanup` | fixes-pr is fully contained in live-cleanup (`onlyA=0`, `onlyB=8`) and has open PR #9024 | fixes-pr is the submitted PR slice; live-cleanup is a superset work branch | High |
| `feature/middle-click-popup-undo-fix` vs `feature/middle-click-popup-visual-query-enhancements` | undo-fix is contained in visual-query-enhancements (`onlyA=0`, `onlyB=1`) and has open PR #9029 | undo-fix is a narrow PR; visual-query-enhancements is a broader follow-up local branch | High |
| `feature/paint-round-corners-reshape-overlay` vs `feature/paint-round-corners` | reshape-overlay is contained in paint-round-corners (`onlyA=0`, `onlyB=2`) and parent has open PR #8916 | reshape-overlay is likely an intermediate or local-only branch | High |
| `feature/editor-cleanup-plus-fixes` vs `feature/editor-cleanup-plus-live-cleanup` | heavy divergence (`onlyA=101`, `onlyB=10`) and no PR on older branch | older fork point or accidental branch base from non-upstream history | Medium |

## Redundancy Candidates (do not delete until you confirm)

These are the best candidates to retire after you confirm there is no needed unique work:

- `feature/paint-round-corners-reshape-overlay` (subset of `feature/paint-round-corners`)
- `feature/editor-cleanup-plus-fixes-pr` OR `feature/editor-cleanup-plus-live-cleanup` (if one PR scope is enough)
- `fix/new-blockly-compat` (already present in `upstream/master`)

These are not redundant, but currently not tied to an open PR:

- `parked/custom-menu-bar` (intentionally parked)
- `feature/find-bar-v2` (active; keep)
- `feature/paint-rig-tool` (active; keep)
- `feature/spritesheet-import` (active; keep)

## Target State Plan (confirmation-first)

Goal: every intended work item lives in one explicit feature/PR branch, then `dev` is recreated from fresh `upstream/master` and rebuilt by selectively merging only the branches you choose.

Suggested sequence:

1. Confirm canonical branch per topic (one branch name per addon/feature area).
2. Confirm archive list (branches to delete locally and optionally on origin).
3. Ensure each kept branch is pushed and linked to a PR (open or intentionally deferred).
4. Create fresh integration branch from upstream:
	- keep old `dev` as backup (for example `dev-legacy-2026-07-04`)
	- create new `dev` from `upstream/master`
5. Merge back only canonical branches in chosen order.
6. Run validation and resolve conflicts.

I will not execute any branch deletion, renaming, or `dev` recreation until you explicitly approve each step.

## Rebuild Status (2026-07-04)

- Completed: backup branch `dev-legacy-2026-07-04` created from old `dev`.
- Completed: `dev` reset to `upstream/master` (same tip commit).
- Completed: merged into fresh `dev`:
	- `pr/swap-local-global`
	- `feature/scratch-project-inspector-differ`
	- `feature/find-bar-v2`
	- `feature/middle-click-popup-undo-fix`
	- `feature/middle-click-popup-visual-query-enhancements`
	- `feature/editor-cleanup-plus-fixes-pr`
	- `feature/editor-cleanup-plus-live-cleanup`
	- `feature/custom-zoom`
	- `feature/paint-boolean-ops`
	- `feature/paint-canvas-pan`
	- `feature/paint-gradient-editor`
	- `feature/paint-round-corners`
	- `feature/paint-stroke-options`
	- `feature/spritesheet-import`
- Completed: `feature/paint-rig-tool` integrated via focused cherry-pick of the rig-tool addon commit (direct branch merge was skipped due mixed-history conflicts).

## Proposed Merge-In Branches (excluding parked/retired)

Primary keep/merge candidates:

- `pr/swap-local-global`
- `feature/scratch-project-inspector-differ`
- `feature/find-bar-v2`
- `feature/middle-click-popup-undo-fix`
- `feature/middle-click-popup-visual-query-enhancements`
- `feature/editor-cleanup-plus-fixes-pr`
- `feature/editor-cleanup-plus-live-cleanup`
- `feature/custom-zoom`
- `feature/paint-boolean-ops`
- `feature/paint-canvas-pan`
- `feature/paint-gradient-editor`
- `feature/paint-rig-tool`
- `feature/paint-round-corners`
- `feature/paint-stroke-options`
- `feature/spritesheet-import`

Hold for explicit confirmation before merge:

- `feature/editor-cleanup-plus-fixes` (older diverged sibling)

## Confirmation Checklist (answer yes/no per item)

1. Yes (2026-07-04): Keep `pr/swap-local-global` as canonical; retire `feature/swap-local-global-multi-sprite-conversion`.
2. Yes (2026-07-04): Keep `feature/paint-round-corners`; retire `feature/paint-round-corners-reshape-overlay`.
3. Yes (2026-07-04): Keep PR branch `feature/editor-cleanup-plus-fixes-pr`; treat `feature/editor-cleanup-plus-live-cleanup` as optional superset branch.
4. Yes (2026-07-04): Keep PR branch `feature/middle-click-popup-undo-fix`; also keep renamed follow-up branch `feature/middle-click-popup-visual-query-enhancements` (do not retire now).
5. Yes (2026-07-04): Archived `fix/new-blockly-compat` (deleted local ref; no `origin` ref existed).
6. Yes (2026-07-04): `custom-menu-bar` is parked as `parked/custom-menu-bar`; `feature/find-bar-v2`, `feature/paint-rig-tool`, and `feature/spritesheet-import` are active branches to keep.

## Branch Cleanup Log

- 2026-07-04: deleted `feature/find-bar-extensions` locally and on `origin` after confirming `feature/find-bar-v2` as canonical for finder work.
- 2026-07-04: deleted local branch `feature/swap-local-global-multi-sprite-conversion` after confirming `pr/swap-local-global` as canonical.
- 2026-07-04: deleted local branch `feature/paint-round-corners-reshape-overlay` after confirming `feature/paint-round-corners` as canonical.
- 2026-07-04: confirmed `feature/editor-cleanup-plus-fixes-pr` as canonical PR branch; kept `feature/editor-cleanup-plus-live-cleanup` as optional superset work branch.
- 2026-07-04: renamed `feature/middle-click-popup-enhancements` to `feature/middle-click-popup-visual-query-enhancements`; kept it as a follow-up branch while retaining PR branch `feature/middle-click-popup-undo-fix`.
- 2026-07-04: deleted local branch `fix/new-blockly-compat` (no `origin` branch existed) after confirming the fix is already in `upstream/master`.
- 2026-07-04: renamed local branch `feature/custom-menu-bar` to `parked/custom-menu-bar` to mark it as parked work.
- 2026-07-04: pushed `parked/custom-menu-bar` to origin and deleted `origin/feature/custom-menu-bar`.
- 2026-07-04: marked `feature/find-bar-v2`, `feature/paint-rig-tool`, and `feature/spritesheet-import` as active branches to keep (no PR yet).
- 2026-07-04: deleted `andy/paint-gradient-editor-refactor` locally and on `origin` after confirming its unique refactor commit was not needed.
- 2026-07-04: merged 14 approved branches into fresh `dev`; only `feature/paint-rig-tool` remains pending due mixed-history conflicts on direct merge.
- 2026-07-04: integrated `feature/paint-rig-tool` into fresh `dev` by cherry-picking commit `a5bcb8f0` (direct merge had extensive unrelated conflicts).
