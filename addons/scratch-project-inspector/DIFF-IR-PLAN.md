# Plan: Shared block IR for diffing + pseudocode round-trip

## Context / problem

`scratch-project-inspector` currently has THREE independent, ad hoc traversals of raw
VM block JSON that all duplicate the same Scratch-specific quirks (procedures_call
proccode/argumentids, dual-format broadcasts, shadow vs non-shadow, parameter vs
variable namespaces):

1. `blockNameKey()` in `project-differ.js` — flattens a block (2 levels deep) into a
   string key used for LCS match/mismatch decisions.
2. The `changedFields` collector in `diffScriptBody()` (`project-differ.js`) — a
   second, capped-depth walk that explains *what* changed.
3. `formatBlockLine()` in `userscript.js` — a third walk that renders a block to a
   pseudocode line for display.

Plus a fourth, separate pipeline: `projectToPseudocode()`/`targetToPseudocode()`
(`userscript.js`, blocks → text) → `pseudocode-parser.js` `parsePseudocode()` (text →
AST, regex-based, no back-reference to real block IDs) → `ast-to-blocks.js`
`astToBlocks()` (AST → fresh VM blocks, already fairly mature: has a `SLOT_SHADOWS`
table, boolean-gate coercion, `resolveVarId()`, `buildFields()`/`buildInputEntry()`) —
used today from a developer-tool test button (`userscript.js` ~L790-852) to inject
parsed pseudocode.

## Goal

Introduce one canonical IR for "a block, described abstractly", built directly from
live VM block JSON (keeping the real block `id`/target linkage), and make diffing,
pseudocode rendering, and pseudocode-driven injection all consume/produce it — instead
of each maintaining its own bespoke traversal. Also expose the granularity this already
computes (`changedFields`) but currently threw away, for per-token diff highlighting.

## Status

- **Phase 0 — done, shipped.**
- **Phase 1 — done, shipped.**
- **Phase 2 — done, shipped.**
- **Phase 3 — done, shipped (rendering only — see scope note below).**
- **Post-launch fixes (from real Chrome testing) — done, shipped.** See section below.

---

## Post-launch fixes — found during real Chrome testing ✅ DONE

Manual testing against the Arcade Racer example surfaced three real issues not caught
by the Node-script verification (which only checks computed diff *data*, not the
rendered UI's interaction with that data):

1. **`slotKey` never normalised literal slots.** `collectSlotDiff`/`normalizeSlotValue`
   (the "explain what changed" path) correctly applied the sprites NameMap fallback to
   literal/menu slots (e.g. a `touching [Sprite2]?` dropdown), but `slotKey` (the
   *match-key* path used by `irKey` to decide "same block" vs "changed") had a literal
   case that used the raw value directly, skipping normalisation entirely. Net effect:
   any statement referencing a *renamed sprite* (via `touching`, `distance to`,
   `point towards`, `go to`, etc.) was always flagged as "changed" even though the
   rename was already known — and then the (correctly-normalising) changedFields
   explainer found nothing to report, so the UI showed a full, unexplained line pair.
   Fixed: `slotKey`'s `"literal"` case now calls `normalizeSlotValue()`, same as the
   `variable`/`list`/`broadcast` cases already did. Verified against the real
   `ref.json`/`stu.json` fixtures: the `Walls Hit`→`walls hit` and
   `Track Hit`→`Track Hitbox` renamed-sprite false positives are gone.

2. **Word-level highlighting still gave up when a value appeared twice in one line**
   (e.g. `add (item (i) of [TRACK Y]) to [TRACK Y]` → `... [TRACK X]) to [TRACK Y]` —
   "TRACK Y" appears twice, once as the part that changed and once as the unrelated
   destination list, so the original *value-substring-search* highlighter
   (`buildLineWithHighlights`) bailed out as ambiguous and fell back to full plain
   lines). Fixed by replacing it entirely with a **word-level positional LCS diff**
   between the two rendered lines (`wordDiff`/`tokenizeLine`/`buildDiffLineFragment`
   in `userscript.js`) — the same LCS technique already used for statement-level
   diffing in `project-differ.js`, just applied at word granularity. Position, not
   content, disambiguates which occurrence changed, so this is correct regardless of
   repeated names, and no longer depends on `changedFields` values at all (removed
   the Set-building + null-fallback logic; a word-diff is always attempted whenever
   `refLine !== stuLine`, since it can't produce a false ambiguous-match failure).

3. **Rendering was NameMap-blind — the deeper architectural issue.** Even with fixes
   1-2, comparing two *independently rendered* pseudocode lines will always show a
   renamed variable/list/broadcast/sprite as a textual difference, because
   `formatBlockLine`/`field`/`resolveInput` render each project's own raw names with
   no knowledge of the other project's vocabulary — even though the diff engine
   (`irKey`/`collectNodeDiff`) already treats the rename as equivalent. E.g.
   `if <(length of [skid x]) > (MAX SKID LENGTH)> then:` vs
   `if <(length of [Skid X]) > (300)> then:` — `skid x`/`Skid X` is an already-known
   rename (should never be highlighted), while `MAX SKID LENGTH`/`300` is a genuine
   difference (should be). Fixed by adding `normalizeNodeForDisplay(node,
   spriteNameMap)` (exported from `project-differ.js`, reusing its existing
   `normalizeFieldValue`/`normalizeSlotValue` helpers) — returns a deep copy of an
   IRNode with every variable/list/broadcast/sprite/procedure/parameter name rewritten
   to the **student's** equivalent. `renderDiffContent` now calls this on the **ref**
   side only (via a new `getNormalizeNodeForDisplay()` lazy loader, same pattern as
   `getBlockToIR()`) before rendering — for the "change" op's ref line, the "delete"
   op's ref line, and matched/unmatched script hat text — so both lines end up using
   the student's naming and the word-diff only ever highlights genuine differences.
   The student side is never normalised (it's already in its own vocabulary).
   Verified against the real fixtures: the raw ref node has `LIST: "skid x"`
   throughout; `normalizeNodeForDisplay` correctly rewrites every occurrence
   (including deeply nested ones, e.g. inside `data_deleteoflist` two levels into a
   `control_repeat` substack) to `LIST: "Skid X"`, while `changedFields` correctly
   isolates the real difference as `CONDITION.OPERAND2: {ref: "MAX SKID LENGTH",
   student: "300"}`.

**Files touched:** `project-differ.js` (`slotKey` fix; new exported
`normalizeNodeForDisplay`/`normalizeSlotForDisplay`/`normalizeSubstackForDisplay`),
`userscript.js` (new `getNormalizeNodeForDisplay()` loader; replaced
`buildLineWithHighlights` with `tokenizeLine`/`wordDiff`/`buildDiffLineFragment`;
`renderDiffContent` now threads `spriteNameMap` through its per-match loop and
normalises every ref-side node before rendering).

### Round 2 — two more gaps found in further Chrome testing

4. **`sensing_of`'s `PROPERTY` field was never normalised.** `PROPERTY` can hold
   either a fixed built-in property name (`x position`, `volume`, etc.) or the name
   of a variable belonging to the sprite named in the sibling `OBJECT` input (Scratch
   lets `(PROPERTY of OBJECT)` read any of that target's own variables) — e.g.
   `(abs of (fwd velocity of [Car]))` renamed to `(abs of (Forward Velocity of
   [Car]))`. `normalizeFieldValue` had no case for `PROPERTY` at all, so this always
   showed as a false "change" even though the rename was already known. Fixing this
   required node-context (to read the sibling `OBJECT` input and know *which*
   sprite's variables to check), which may be a **different sprite** than the one
   the block lives in — so `normalizeFieldValue`'s signature changed from
   `(opcode, fieldName, value, spriteNameMap)` to `(node, fieldName, value,
   spriteNameMap)`, and `buildNameMaps` now attaches `allNameMaps` (a shared pointer
   to every sprite's own `SpriteNameMap`) onto each per-sprite map, avoiding having
   to thread a second `nameMaps` parameter through every diff/render function that
   doesn't otherwise need it. New `normalizeSensingOfProperty()` +
   `SENSING_OF_BUILTIN_PROPERTIES` handle the built-in-vs-variable distinction.

5. **Moved (reordered) statements looked like a no-op, or worse, were invisible.**
   Pure LCS-based diffing (as used for the per-statement alignment) can't represent
   "this statement moved" — preserving relative order is exactly what LCS optimises
   for, so a relocated statement with no other change surfaces as an unrelated
   delete-at-its-old-position plus insert-at-its-new-position. Since both render
   identically, this either looks like redundant noise or gets lost among other
   changes — even though a reorder can be a real behavioural bug in Scratch
   (execution order matters). Added `markMovedPairs()` — a post-processing pass in
   `diffScriptBody()` that pairs up any unmatched delete/insert whose IRNodes have an
   *identical* `irKey` (same opcode, same normalised fields/inputs) and marks both
   with `moved: true` plus a cross-reference (`movedToBlockId`/`movedFromBlockId`).
   `renderDiffContent` now renders a moved pair as a single distinct `↕ moved: …`
   line (new `sa-diff-line-moved`/`sa-diff-moved` styles, blue) instead of two
   separate delete/insert lines, and excludes it from the changed/inserted/deleted
   counts (`moved` is now its own badge/counter).

**Verification (round 2):** confirmed against the real fixtures — the `sensing_of`
case (`fwd velocity`/`Forward Velocity` on sprite `Car`, read from sprite `Engine`)
now shows `[match]` with `changedFields: null` where it previously showed a false
`[change]`. The moved-block case (`car y += speed y` → `Car Y += speed y`, a
simultaneous move *and* case-rename) now shows both the delete and insert ops with
`moved: true` correctly cross-referencing each other. Full fixture sweep (all 3
ref/stu pairs) re-run after both fixes: no crashes, `match` counts increased and
`change` counts decreased as expected (more false positives resolved), exactly one
moved-pair detected in each of the two Arcade Racer fixtures and zero in MoonLeaf
(consistent with there being no reordering in that project).

---

## Phase 0 — Surface existing per-field diff data (no architecture change) ✅ DONE

Implemented in `userscript.js`:

- `buildLineWithHighlights(prefix, line, values)` — highlights occurrences of a
  `Set<string>` of values inside a rendered pseudocode line, wrapping each in
  `<mark class="sa-diff-token-changed">`. Returns `null` (signalling "fall back to a
  plain line") if any value is missing, empty, appears more than once, or ranges
  overlap — never risks highlighting the wrong token.
- `makeDiffBodyLineNode(diffType, contentNode, blockId, spriteName, extraClass)` —
  generalizes the old `makeDiffBodyLine` (text-only) to accept an arbitrary node (a
  highlighted fragment). `extraClass` is used to apply `sa-diff-line-partial`.
- The `"change"` diffOp branch in `renderDiffContent()` now shows **both** the before
  (ref) and after (student) lines when `changedFields` (already computed in
  `diffScriptBody()`, `project-differ.js`) lets us pinpoint the changed token(s)
  unambiguously on both sides — each line highlights only its own differing token(s).
  Falls back to the old full plain delete+insert line pair otherwise.

CSS (`userstyle.css`):

- `.sa-diff-line-partial` — resets a delete/insert line's text colour to neutral
  (`#cdd6f4`) so unchanged surrounding text doesn't look colored. Applied only to the
  new two-line token-highlighted rendering — fully-plain delete/insert lines (whole
  block inserted/deleted, or the "change" fallback) intentionally keep the old
  whole-line red/green coloring, since the entire line *is* the diff in that case.
- `.sa-diff-token-changed` — no color of its own; `.sa-diff-line-delete
  .sa-diff-token-changed` (red) / `.sa-diff-line-insert .sa-diff-token-changed` (green)
  tint just the marked token via descendant selectors, matching the enclosing line's
  delete/insert context.
- No tooltip — `buildLineWithHighlights` takes a `Set<string>`, not a `Map` with
  titles; both before/after lines are visible directly so a hover tooltip was
  redundant (an earlier single-line + tooltip iteration was tried and rejected).

**Known limitation (by design, not a bug):** `changedFields` only inspects a block's
own fields plus ONE extra level into a direct non-shadow input child's VARIABLE/LIST
field. Confirmed via Chrome testing that this misses:

- Field changes 2+ levels deep, e.g.
  `set [dy] to ((item (track idx) of [TRACK Y]) - (car y))` →
  `set [dy] to ((item (1) of [TRACK Y]) - (Car Y))`
  (both differences live inside `operator_subtract`'s operands, one level past what the
  walker checks) — falls back to plain full-line display, no highlight.
- Genuine structural rearrangement (not a field value at all), e.g.
  `turn right (((turn velocity) * (config: turn speed)) * (temp)) degrees` →
  `turn right ((turn velocity) * ((config - turn speed) * (temp))) degrees`
  (`(A*B)*C` reassociated to `A*(B*C)`) — no field-level diff can express this; needs a
  real recursive tree diff.

Decision: do **not** patch the capped-depth string-based walker further to chase these
— that would be throwaway effort once Phase 1/2's unbounded-depth IR tree-diff lands.
Both examples are recorded as motivating regression fixtures for Phase 2 (see
Verification below). Also noted in passing: `"config: turn speed"` vs
`"config - turn speed"` — inconsistent custom-block-with-argument rendering
punctuation (colon vs dash) in the pseudocode formatter, unrelated to the differ; not
addressed by this plan, flag separately if it turns out to matter.

---

## Phase 1 — Extract canonical IR builder *(depends on: none)* ✅ DONE

Implemented in the new `block-ir.js`: `blockToIR(blockId, blocksDict)` and
`scriptToIR(hatBlockId, blocksDict)` (an alias, for readability at script-hat call
sites). Matches the schema below exactly as designed, with two refinements found
during implementation:

- **`procedures_definition` mutation promotion.** A definition block's signature
  actually lives on its `custom_block` input's target — the `procedures_prototype`
  shadow block (proccode/argumentnames/argumentdefaults) — not on the definition
  block itself. The IR promotes that child's decoded mutation onto the
  `procedures_definition` IRNode's own `mutation` field, and `custom_block` is
  excluded from `inputs` entirely (like `SUBSTACK`/`SUBSTACK2`, it's Scratch-internal
  plumbing, not part of the executable expression tree). This mirrors how
  `procedures_call` already carries its own mutation directly, giving definition and
  call sites a symmetric, predictable shape.
- **Substacks are arrays, not just linked lists.** `blockToIR` still populates each
  node's `next` recursively (so the whole chain is only ever built once), and
  `substacks.SUBSTACK`/`SUBSTACK2` are built by following that same `.next` chain
  into a flat array of the *same* IRNode objects (no rebuilding, no duplicate work) —
  giving callers both a linked-list view (`.next`) and an array view for convenience.

Verified with a throwaway local Node sanity script (created, run, and deleted — not
committed) against `examples/ref.json`: converted all 36 top-level scripts across 13
targets without crashing; confirmed literal absorption (shadow `math_number` →
`{kind:"literal", value:"1"}`), broadcast/variable/list unification across both
storage formats, `procedures_call`/`procedures_definition` mutation decoding
(`argumentids` etc. become real arrays) and mutation promotion, `SUBSTACK` arrays
building correctly for `control_forever`, and recursive nested-reporter resolution
(`{kind:"block", node: IRNode}`) for a real `operator_add` inside a `procedures_call`
argument.

1. Add a new module, `block-ir.js`, with a function
   `blockToIR(blockId, blocksDict) → IRNode` that recursively builds:
   ```
   {
     id, opcode,
     fields: { name: value },
     inputs: { name: InputSlot },
     next: IRNode | null,
     substacks: { SUBSTACK?: IRNode[], SUBSTACK2?: IRNode[] },
     mutation,
   }
   ```
   — one node per REAL (non-shadow) block only; `id` is always the live block ID.
2. **Shadows never become their own IRNode.** They're absorbed into the parent's
   `InputSlot` as a plain literal value — no shadow IDs, x/y, or `shadow:true` noise
   surfaces in the IR. `InputSlot` is a discriminated union, unifying Scratch's two
   competing storage formats (shadow-block-with-field vs. inline type-11/12/13
   primitive) into one shape:
   - `{ kind: "literal", value }` — any shadow-derived or inline number/string/color
   - `{ kind: "variable" | "list" | "broadcast", name }` — collapses both storage
     formats into one
   - `{ kind: "block", node: IRNode }` — a real nested reporter, recurses
   - `{ kind: "empty" }` — slot has nothing plugged in
3. Field names stay as Scratch's own per-opcode vocabulary (`VARIABLE`, `NUM`, `TEXT`,
   etc.) unchanged — only the input envelope is normalized, not block-specific field
   semantics (pseudocode formatters already key off these names).
4. Mutations (`argumentids`/`argumentnames`/`argumentdefaults`, `proccode`) are decoded
   ONCE into real arrays/objects on the node, replacing the repeated ad hoc
   `JSON.parse()` calls scattered across `collectExprEvidence`/`blockNameKey`.
5. Port the special-casing currently duplicated across `blockNameKey`/`changedFields`/
   `formatBlockLine`/`describeSlot` into this single builder: shadow vs non-shadow
   inputs, inline primitives (types 11/12/13), `procedures_call` proccode +
   `argumentids` positional resolution, dual-format broadcast extraction
   (`extractBroadcastName`), parameter vs. variable field namespaces.
6. Add a `scriptToIR(hatBlockId, blocksDict) → IRNode` entry point mirroring
   `lineariseScript()`'s traversal order (hat → next chain, substacks inline).
7. No behavior change yet — this phase only adds the module; nothing consumes it.

## Phase 2 — Migrate the differ onto the IR *(depends on Phase 1)* ✅ DONE

`project-differ.js` now imports `scriptToIR` from `block-ir.js` and no longer
touches raw block dicts for per-block matching/diffing:

- `lineariseScript()` → `lineariseScriptIR()`, which builds the IR once via
  `scriptToIR()` and flattens it (hat → next chain, substacks inlined in reading
  order) into an array of IRNodes directly — no more `{id, opcode, block}` wrapper.
- `blockNameKey()`/`describeSlot()` → `irKey()`/`slotKey()`, with **no depth cap**
  (the old version stopped 2 levels deep). `normalizeFieldValue()`/
  `normalizeSlotValue()` carry the same SpriteNameMap normalisation rules
  (variables/lists/broadcasts/parameters), plus the same sprite-name fallback for
  unrecognised literal/shadow values (e.g. a "point towards [Sprite2]" dropdown)
  that `describeSlot` had.
- The old, capped `changedFields` walk in `diffScriptBody()` → `collectNodeDiff()` +
  `collectSlotDiff()`, a real recursive tree-diff with **no depth cap**. Only
  differences describable as a single directly-renderable string (a literal value,
  or a variable/list/broadcast name — even across a change of *kind*, e.g. a
  variable reference replaced by a hardcoded literal) are recorded; genuine
  structural changes (a nested reporter replaced by a value of a different shape,
  or two nested reporters with different opcodes — e.g. the `(A*B)*C` → `A*(B*C)`
  reassociation case from Phase 0) are intentionally left unrecorded, since there's
  no simple string to safely highlight for those without a Phase-3 pseudocode
  renderer for the subtree. This is a conscious, documented limitation, not a bug —
  the overall match/mismatch decision (via `irKey`) is correct regardless; only how
  much of a "change" can be *explained* is affected.
- `extractBroadcastName()` is gone entirely — the IR already unifies both of
  Scratch's broadcast storage formats (shadow menu block vs. inline primitive)
  into one `{kind:"broadcast", name}` shape, so `buildNameMaps()`'s
  `event_broadcast`/`event_broadcastandwait` evidence collection just reads
  `node.inputs.BROADCAST_INPUT.name` directly.
- `collectExprEvidence()` → `collectIRExprEvidence()`/`collectSlotExprEvidence()`,
  same rename-evidence-gathering role (depth capped at 5, unchanged — this cap is
  about evidence-gathering breadth for the NameMap, not correctness, and the plan
  never called for changing it), simplified since the IR already collapses both
  variable/list storage formats into one case instead of two.
- `lcsDiff()`, `matchSprites()`, `coarseMatchScriptsForSprite()`,
  `refinedMatchScriptsForSprite()`, `matchProcedures()`, `collectProcdefs()`, and
  `collectOpcodes()` are all **unchanged** — they either only need opcode strings
  (unaffected by the IR) or already had their own separate raw-block field-reading
  logic (`hatKey()` in `refinedMatchScriptsForSprite`) that the plan didn't call
  for migrating.
- The `DiffOp` shape returned by `diffScriptBody()` is **unchanged**
  (`{type, refBlockId, studentBlockId, opcode, changedFields}`), so nothing in
  `userscript.js` (Phase 0's rendering) needed to change for this phase.

**Verification performed:** a throwaway Node comparison script (run and deleted,
not committed) loaded the pre-migration `project-differ.js` from git history
(`git show HEAD:...`) side-by-side with the migrated version and ran both against
all three example fixture pairs in `examples/`
(`ref.json`/`stu.json`, `ref62.json`/`stu53.json`, `moonleaf-ref.json`/
`moonleaf-stu.json`). Results: **sprite/script matching (counts, pairing, and
confidence) were byte-for-byte identical before and after** — confirming zero
regression in Phases 1-4 of the differ. `change`/`match` counts within already-
matched scripts shifted slightly as expected (e.g. Arcade Racer: 218→215 matched,
24→27 changed) — a handful of previously-invisible deep differences (hidden by the
old depth-2 cap) now correctly surface as "change" instead of a false "match".
`changedFields`-explainable change count roughly doubled on every fixture (e.g.
11→20, 5→16, 3→4), confirming the unbounded-depth tree-diff explains substantially
more of what it detects than the old capped walker did.

## Phase 3 — Point pseudocode rendering + injection at the same IR ✅ DONE (rendering only)

**Scope actually implemented:** item 1 (rendering) only — `formatBlockLine`/`getHatText`/
`renderSequence`/`targetToPseudocode`/`projectToPseudocode`/`targetToComparePseudocode`/
`projectToComparePseudocode` now render from `IRNode` via `blockToIR`. Items 2-3
(aligning `pseudocode-parser.js`'s AST shape with the IR and generalizing
`ast-to-blocks.js`'s writer) were explicitly deferred — not started.

**Key discovery driving the design:** every entry in `INLINE_FORMATTERS` /
`STATEMENT_FORMATTERS` / `C_BLOCKS` (~80 opcodes) only ever reads fields/inputs
through five shared helpers (`field`, `resolveInput`, `resolveSlot`, plus the
now-removed `resolveLiteral`/`renderReporter`) — never `.fields`/`.inputs` directly.
That meant migrating rendering onto the IR only required rewriting those shared
helpers plus the handful of top-level entry points; none of the ~80 per-opcode
formatter entries needed to change.

**Schema change (retroactive to Phase 1):** the literal `InputSlot` gained a
`shape` tag (`"number" | "colour" | "string" | "menu"`) in `block-ir.js`. Without
it, rendering couldn't tell an inline number (needs `(10)` round brackets) from a
colour (bare `#ff0000`) from a bare shadow-menu dropdown (e.g. a costume/sound/
target picker — no self-brackets, wrapped by the caller if needed) — the original
renderer used the raw sb3 primitive type code (4-13) for exactly this, which the
clean IR had deliberately dropped. This is genuine rendering-relevant semantic
info, not shadow-storage noise, so it was added back deliberately.

**Async propagation (the big structural change):** `block-ir.js` had to be loaded
the same lazy, dynamically-imported way as `project-differ.js`/`pseudocode-parser.js`
— per this file's own explicit comment ("Keeping these lazy means a syntax error in
parser/converter files won't prevent the toolbar button from appearing"), not an
arbitrary choice. That forced every top-level entry point that converts raw blocks
→ IR to become `async`:
- `renderDiffContent` (now awaits `getBlockToIR()` once, then calls the resolved
  `blockToIR` synchronously at each of its ~6 conversion sites)
- `targetToPseudocode` / `targetToComparePseudocode` (same pattern, once per target)
- `projectToPseudocode` / `projectToComparePseudocode` (await each target call)
- `renderIssuesContent` (awaits/void's `renderDiffContent` when on the diff tab)
- `handleCopyAndAnalyze`, `triggerBugPrompt` (awaits `projectToPseudocode`/
  `projectToComparePseudocode`)

Crucially, **`formatBlockLine`/`getHatText`/`renderSequence`/all ~80 formatter
entries stay fully synchronous** — once a hat's IR tree is built (one `blockToIR`
call), every nested reporter is already an in-memory object (`slot.node`), so
traversal needs no further imports or awaits. Async is confined to the handful of
raw-block → IR conversion points, not spread through the whole rendering pipeline.
All ~10 call sites of the now-async functions were updated (`await` where already
in an async context, `void fn(...)` for fire-and-forget UI population, matching the
existing `void renderCompareTab(tab)` convention already used in this file).

**Other implementation notes:**
- `getProcSignature(blocks, defBlock)` (raw-block-based) was kept, unchanged, but
  narrowed to ONLY `getOrderedTopLevelIds`'s sort comparator (a private ordering
  concern, not shared with the differ) — a new `procSignatureFromNode(defNode)`
  serves the actual rendering call sites, using the definition's `mutation`
  (already promoted from its `procedures_prototype` child by `blockToIR`).
- `formatProcCall`/`formatProcCallWithBlocks` (two near-duplicate functions, one of
  which — `formatProcCall` — was dead code, never called) collapsed into one
  `formatProcCall(node)`, reading `node.mutation.argumentids` directly (already a
  decoded array).
- `getOrderedTopLevelIds`/`collectCallOrder`/`hatPriority` were deliberately left
  untouched (still raw-block-based) — they're internal sort/ordering heuristics
  private to `targetToPseudocode`, not part of the duplicated-traversal problem
  this plan targets.

**Verification:** a real bug was caught this way — the initial edit updated
`targetToPseudocode`/`targetToComparePseudocode` and their own internal loops, but
missed that `projectToPseudocode`'s loop calling `targetToPseudocode` also needed
`await` (it silently pushed unresolved Promises into the output array). Caught by
extracting the entire rendering section (old, from git history, vs. new) into two
throwaway standalone Node modules and diffing `projectToPseudocode`/
`projectToComparePseudocode` output against all 6 example fixtures
(ref/stu × 3 project pairs) — fixed, then re-verified **byte-for-byte identical**
output on all 6 fixtures for both the full and slim renderers. Scripts and temp
`package.json` (needed for Node ESM resolution of `.js` files without a repo-wide
`"type": "module"`) were deleted after verification, not committed.

**Items 2-3 (parser/injector shape alignment) — decided against, not just deferred.**
See "Decisions" and "Further considerations" below for the full reasoning: the
parser's AST and the IR have fundamentally different provenance (ambiguous
human/AI-edited text vs. unambiguous binary block data), and forcing one shape onto
both would either pollute the IR's clean resolved-value guarantee or make the parser
guess things it can't reliably know without live VM access. If a "materialize IR into
blocks" need arises later, build a small dedicated `IRNode → VM blocks` writer that
reuses `ast-to-blocks.js`'s low-level utilities (`SLOT_SHADOWS`, `resolveVarId`,
`uid()`) rather than unifying the two AST shapes.

---

## Relevant files

- `project-differ.js` — `blockNameKey()`, `describeSlot()`, `lineariseScript()`,
  `diffScriptBody()` (`changedFields` collector), `collectExprEvidence()`,
  `extractBroadcastName()` — migrate onto IR in Phase 2.
- `userscript.js` — `renderDiffContent()`, `makeDiffBodyLine()`/`makeDiffBodyLineNode()`,
  `buildLineWithHighlights()`, `formatBlockLine()`, `getHatText()`, `renderSequence()`,
  `targetToPseudocode()`, `projectToPseudocode()`.
- `pseudocode-parser.js` — `parsePseudocode()`, `parseExpr()`; align AST node shape
  with IR in Phase 3.
- `ast-to-blocks.js` — `astToBlocks()`, `SLOT_SHADOWS`, `buildFields()`,
  `buildInputEntry()`, `resolveVarId()`; generalize in Phase 3, preserve existing
  logic.
- New file (Phase 1): `block-ir.js` — `blockToIR()`, `scriptToIR()`.
- `PSEUDOCODE-CONVERTER.md` — update to reflect the merged architecture once Phase 3
  lands (it currently describes `ast-to-blocks.js` as TODO, but it's already
  substantially implemented).

## Verification

1. Manual: load the existing example project pairs in `examples/` (e.g.
   `Arcade Racer m5.2.sb3` vs `Arcade Racer m5.3 - user project.sb3`,
   `MoonLeaf ep3 student.sb3` vs `Moonleaf e03 ref.sb3`) through the addon's diff panel
   before and after each phase, compare sprite/script match %, rename inference, and
   diffOps counts for regressions.
2. Phase 0: visually confirm changed-field highlighting appears inline for known
   single-field-change cases and falls back to full delete/insert lines when
   `changedFields` is null or ambiguous. ✅ done.
3. Phase 2: add/extend fixtures under `examples/` for a case with a deeply nested
   expression change to confirm the unbounded-depth tree-diff catches it where the old
   capped walk didn't. Concrete cases already observed to fail under Phase 0's capped
   walker (use as regression fixtures once Phase 2 lands):
   - `set [dy] to ((item (track idx) of [TRACK Y]) - (car y))` →
     `set [dy] to ((item (1) of [TRACK Y]) - (Car Y))` — 2-level-deep field changes.
   - `turn right (((turn velocity) * (config: turn speed)) * (temp)) degrees` →
     `turn right ((turn velocity) * ((config - turn speed) * (temp))) degrees` —
     structural reassociation, not a field value change at all.
4. Phase 3: use the existing "Parse pseudocode → AST (developer tool)" test button
   (`userscript.js` ~L338-352) and the `astToBlocks` test flow (~L790-852) to confirm
   pseudocode → blocks injection still works unchanged after the refactor.
5. No project-wide automated test suite exists for this addon — rely on the manual
   example-project verification above plus the existing developer-tool test buttons
   already in the UI.

## Decisions

- IR is derived directly from live VM block JSON, NOT from rendered pseudocode text —
  keeps real block IDs for highlighting/navigation (`highlightDiffBlocks`,
  `handleGotoBlock`) and avoids a lossy text round-trip for the diff path.
- The `pseudocode-parser.js` text→AST path keeps its own, independently-shaped AST —
  **not** aligned to the IR's node shape (decided against, see Further Considerations).
  Its expression nodes use a `{kind: "literal"|"reporter"|"boolean"|"unknown"}`
  taxonomy that reflects genuine parse-time ambiguity (e.g. a bare `(track idx)` is
  optimistically parsed as `data_variable` and only resolved — or coerced to a string
  literal — by `ast-to-blocks.js`'s `resolveVarId()` at injection time, against the
  live VM). The IR's `InputSlot` union is fully resolved by construction because it's
  built from unambiguous binary block data. Unifying the two shapes would require
  either teaching the IR to represent unresolved ambiguity (defeating its purpose for
  diffing/rendering) or making the parser guess identity it can't know without VM
  access (strictly worse than today). Not worth it.
- Existing `SLOT_SHADOWS`/`buildFields`/`resolveVarId` logic in `ast-to-blocks.js` is
  preserved as-is (already correct, hard-won Scratch semantics) — untouched.
- Out of scope: an actual "apply fix" UI action that writes ref blocks into the
  student project — if built later, it should use a small new `IRNode → VM blocks`
  writer (reusing `ast-to-blocks.js`'s low-level utilities), not a unified AST/IR.
- Out of scope: rewriting `lcsDiff()`/top-level LCS opcode-sequence matching strategy —
  only the match/mismatch decision and change explanation move onto the IR.

## Further considerations

1. Phase 0 alone may deliver most of the user-visible value (per-token highlighting)
   for low cost/risk — it's shipped; Phases 1-3 are a separate, larger follow-up to be
   scheduled based on how much the duplicated-traversal maintenance cost bites in
   practice.
2. Parser/injector shape alignment (Phase 3 items 2-3) — settled as **not worth doing**
   (see Decisions above), not merely deferred. Re-open only if a concrete need for a
   generic IR-shaped writer emerges (e.g. an "apply fix" action) — and even then,
   prefer a small new writer over forcing shape unification.
