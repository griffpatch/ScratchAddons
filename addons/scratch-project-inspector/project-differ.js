/**
 * project-differ.js
 *
 * Programmatic diff of two Scratch projects.
 *
 * Phases:
 *  1. Sprite matching  (exact name → normalised name → Jaccard opcode-bag)
 *  2. Coarse script matching  (hat opcode only, no field values)
 *  3. Name mapping  (variable / list / broadcast / procedure renames,
 *                    using positional evidence from coarse script pairs)
 *  4. Refined script matching  (hat opcode + NameMap-normalised hat fields)
 *  5. Block-level diff  (LCS on opcode sequence within matched scripts)
 *
 * Export: diffProjects(refProject, stuProject) → DiffResult
 *
 * DiffResult:
 *  spriteMatches:           [{refTarget, studentTarget, confidence}]
 *  unmatchedRefTargets:     [Target]
 *  unmatchedStudentTargets: [Target]
 *  nameMaps:                Map<refSpriteName, SpriteNameMap>
 *  scriptMatches:           [{refTarget, studentTarget, refScriptId,
 *                             studentScriptId, confidence, diffOps}]
 *  unmatchedRefScripts:     [{target, scriptId}]
 *  unmatchedStudentScripts: [{target, scriptId}]
 *
 * SpriteNameMap: { variables, lists, broadcasts, procedures }
 *   each a Map<refName, {studentName, confidence, isRename}>
 *   (procedures maps refProccode → {studentProccode, confidence, isRename})
 *   Also carries `sprites` (global refSpriteName → studentSpriteName map) and
 *   `allNameMaps` (Map<refSpriteName, SpriteNameMap> — every sprite's own map,
 *   for cross-sprite lookups like sensing_of's PROPERTY).
 *
 * DiffOp: { type: 'match'|'insert'|'delete'|'change',
 *            refBlockId, studentBlockId, opcode, changedFields,
 *            refDepth, studentDepth,
 *            moved?, movedToBlockId?, movedFromBlockId?, swapped?, swappedPrimary? }
 *   `moved` (delete/insert only): true when this op's block is the same
 *   statement as a paired delete/insert elsewhere in the same script, just
 *   relocated — see markMovedPairs. `movedToBlockId`/`movedFromBlockId` point at
 *   the paired op's block ID on the other side.
 *   `swapped` (change only): true when this op is one of an adjacent pair of
 *   "change" ops whose values are each other's exact match — i.e. two statements
 *   that just swapped position, not genuine field edits — see markSwappedPairs.
 *   `swappedPrimary` is set on only the first op of the pair, so renderers can
 *   count/label the pair once.
 *   `refDepth`/`studentDepth`: C-block nesting depth (0 = top level of the script)
 *   of the ref/student block respectively, either may be null if that side has no
 *   block (a pure insert has no refDepth, a pure delete has no studentDepth).
 */

import { scriptToIR } from "./block-ir.js";

// ─── Shared opcode helpers ────────────────────────────────────────────────────

function collectOpcodes(blocks, startId) {
  const opcodes = [];
  const seen = new Set();
  const visit = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const b = blocks[id];
    if (!b || b.shadow) return;
    opcodes.push(b.opcode);
    for (const input of Object.values(b.inputs ?? {})) {
      if (typeof input[1] === "string") visit(input[1]);
    }
    if (b.next) visit(b.next);
  };
  visit(startId);
  return opcodes;
}

function jaccardMultiset(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  const ca = {},
    cb = {};
  for (const x of a) ca[x] = (ca[x] ?? 0) + 1;
  for (const x of b) cb[x] = (cb[x] ?? 0) + 1;
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  let inter = 0,
    union = 0;
  for (const k of keys) {
    inter += Math.min(ca[k] ?? 0, cb[k] ?? 0);
    union += Math.max(ca[k] ?? 0, cb[k] ?? 0);
  }
  return union === 0 ? 0 : inter / union;
}

function getTopLevelScriptIds(blocks) {
  return Object.keys(blocks).filter(
    (id) => blocks[id].topLevel && !blocks[id].shadow && blocks[id].opcode !== "procedures_prototype"
  );
}

// ─── LCS diff ─────────────────────────────────────────────────────────────────

/**
 * Compute a diff between two arrays using LCS.
 * keyFn extracts the comparison key from each element.
 * Returns [{type, ri, si}] where ri / si are indices (−1 for absent).
 */
function lcsDiff(refArr, stuArr, keyFn) {
  const n = refArr.length,
    m = stuArr.length;
  if (n === 0 && m === 0) return [];

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = keyFn(refArr[i]) === keyFn(stuArr[j]) ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && keyFn(refArr[i]) === keyFn(stuArr[j])) {
      ops.push({ type: "match", ri: i, si: j });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push({ type: "delete", ri: i, si: -1 });
      i++;
    } else {
      ops.push({ type: "insert", ri: -1, si: j });
      j++;
    }
  }
  return ops;
}

// ─── Script linearisation (IR-based) ──────────────────────────────────────────

/**
 * Flatten a script body into a list of IRNodes in pseudocode reading order
 * (C-block header → substack body → next — matching renderSequence order).
 * The hat block itself is NOT included. Each IRNode already carries its own
 * `.id`/`.opcode`, so callers no longer need a separate {id, opcode, block} wrapper
 * (compare to the pre-IR version of this function, which built that wrapper by hand).
 *
 * Each node is also tagged with `.depth` (0 = top level of the script body, +1 per
 * level of C-block nesting) so callers that render the flattened list back out
 * (e.g. the diff view) can reconstruct indentation. This is a plain property set
 * during this walk, not part of the IR schema itself — safe because blockToIR
 * builds a fresh node tree on every call, never a cached/shared one.
 */
function lineariseScriptIR(blocks, hatId) {
  const hatNode = scriptToIR(hatId, blocks);
  const tokens = [];
  function visit(node, depth) {
    let cur = node;
    while (cur) {
      cur.depth = depth;
      tokens.push(cur);
      for (const key of ["SUBSTACK", "SUBSTACK2"]) {
        const body = cur.substacks[key];
        if (body && body.length > 0) visit(body[0], depth + 1);
      }
      cur = cur.next;
    }
  }
  if (hatNode?.next) visit(hatNode.next, 0);
  return tokens;
}

// ─── IR node key (structural match/mismatch decision) ────────────────────────

/**
 * Build a string key for an IRNode that captures its opcode + field values + ALL
 * nested input slots, recursively, with NO depth cap (unlike the pre-IR
 * blockNameKey, which stopped 2 levels deep — see DIFF-IR-PLAN.md Phase 2).
 * Optionally normalises variable/list/broadcast/parameter names via a
 * SpriteNameMap. Two nodes with the same opcode and an identical key are
 * considered equivalent; used to decide "match" vs "change" for statement pairs
 * already LCS-aligned by opcode in diffScriptBody.
 */
function irKey(node, spriteNameMap) {
  if (!node) return "";

  // procedures_call: the proccode lives in mutation (not fields) and argument IDs
  // are UUIDs that differ between projects. Key on normalised proccode + positional
  // argument descriptions instead of the default field+input approach.
  if (node.opcode === "procedures_call") {
    const proccode = node.mutation?.proccode ?? "";
    const normalizedProccode = spriteNameMap?.procedures.get(proccode)?.studentProccode ?? proccode;
    const argIds = node.mutation?.argumentids ?? [];
    const parts = [`procedures_call:${normalizedProccode}`];
    for (let i = 0; i < argIds.length; i++) {
      const slot = node.inputs[argIds[i]];
      if (slot) parts.push(`arg${i}=${slotKey(slot, spriteNameMap)}`);
    }
    return parts.join("|");
  }

  const parts = [node.opcode];
  for (const [fn, val] of Object.entries(node.fields)) {
    parts.push(`${fn}=${normalizeFieldValue(node, fn, val, spriteNameMap)}`);
  }
  for (const [name, slot] of Object.entries(node.inputs)) {
    parts.push(`${name}=${slotKey(slot, spriteNameMap)}`);
  }
  return parts.join("|");
}

// Compact description of a single InputSlot, recursing into nested reporter blocks
// with no depth limit.
function slotKey(slot, spriteNameMap) {
  switch (slot.kind) {
    case "literal":
      // Literal shadow-menu values (e.g. a "touching [Sprite2]?" dropdown) may
      // actually be a sprite name — normalise via the sprites map, same as
      // normalizeSlotValue does for the changedFields explanation, so a renamed
      // sprite reference doesn't get flagged as a spurious "change" here.
      return `lit(${normalizeSlotValue(slot, spriteNameMap)})`;
    case "variable":
      return `var(${normalizeSlotValue(slot, spriteNameMap)})`;
    case "list":
      return `list(${normalizeSlotValue(slot, spriteNameMap)})`;
    case "broadcast":
      return `bc(${normalizeSlotValue(slot, spriteNameMap)})`;
    case "block":
      return irKey(slot.node, spriteNameMap);
    case "empty":
    default:
      return "";
  }
}

// Normalise a block's own top-level field value (VARIABLE/LIST/BROADCAST_OPTION/
// a procedure-parameter VALUE) via a SpriteNameMap. Any other field name (e.g. an
// operator dropdown, a key option) passes through unchanged. Takes the whole node
// (not just its opcode) because sensing_of's PROPERTY needs to inspect the
// sibling OBJECT input to know which sprite's variables to check.
function normalizeFieldValue(node, fieldName, value, spriteNameMap) {
  if (!spriteNameMap) return value;
  const opcode = node.opcode;
  if (fieldName === "VARIABLE") return spriteNameMap.variables.get(value)?.studentName ?? value;
  if (fieldName === "LIST") return spriteNameMap.lists.get(value)?.studentName ?? value;
  if (fieldName === "BROADCAST_OPTION") return spriteNameMap.broadcasts.get(value)?.studentName ?? value;
  // Procedure parameter names stored in argument reporter VALUE fields are tracked
  // in a separate parameters NameMap to avoid collision with sprite variables that
  // happen to share the same name (e.g. a variable 'dist' and a param 'dist' are
  // independent namespaces in Scratch).
  if (
    fieldName === "VALUE" &&
    (opcode === "argument_reporter_string_number" || opcode === "argument_reporter_boolean")
  ) {
    return spriteNameMap.parameters?.get(value)?.studentName ?? value;
  }
  if (fieldName === "PROPERTY" && opcode === "sensing_of")
    return normalizeSensingOfProperty(node, value, spriteNameMap);
  return value;
}

// sensing_of's PROPERTY dropdown lists either a fixed built-in property (position,
// direction, costume, size, volume, backdrop) or any of the TARGET sprite's own
// variables — read cross-sprite through this same dropdown. Since the target may be
// a DIFFERENT sprite than the one this block lives in, its variable renames live in
// THAT sprite's own NameMap, not the current one — reached via
// `spriteNameMap.allNameMaps` (a shared pointer to every sprite's NameMap, attached
// once by buildNameMaps) rather than threading a second parameter through every
// diff/render function that doesn't otherwise need it.
const SENSING_OF_BUILTIN_PROPERTIES = new Set([
  "x position",
  "y position",
  "direction",
  "costume #",
  "costume name",
  "size",
  "volume",
  "backdrop #",
  "backdrop name",
]);
function normalizeSensingOfProperty(node, value, spriteNameMap) {
  if (SENSING_OF_BUILTIN_PROPERTIES.has(value)) return value;
  const objectSlot = node.inputs?.OBJECT;
  const objectName = objectSlot?.kind === "literal" ? objectSlot.value : null;
  const targetVariables = spriteNameMap.allNameMaps?.get(objectName)?.variables;
  return targetVariables?.get(value)?.studentName ?? value;
}

// Normalise a variable/list/broadcast InputSlot's name, or (for a literal) fall
// back to the sprites map — a literal shadow value (e.g. a "point towards
// [Sprite2]" dropdown) may actually be a sprite name, matching how the pre-IR
// describeSlot treated any otherwise-unrecognised shadow field value. A
// procedure parameter reference (see PARAMETER_REPORTER_OPCODES below) is
// handled first since it's a `{kind:"block"}` slot with no `.name`/`.value` of
// its own — its displayed name lives one level down, on the wrapped reporter's
// own VALUE field, and is tracked in a separate `parameters` NameMap from
// sprite variables.
function normalizeSlotValue(slot, spriteNameMap) {
  if (slot.kind === "block" && PARAMETER_REPORTER_OPCODES.has(slot.node.opcode)) {
    const paramName = slot.node.fields.VALUE ?? "";
    return spriteNameMap?.parameters?.get(paramName)?.studentName ?? paramName;
  }
  if (!spriteNameMap) return slot.kind === "literal" ? slot.value : slot.name;
  if (slot.kind === "variable") return spriteNameMap.variables.get(slot.name)?.studentName ?? slot.name;
  if (slot.kind === "list") return spriteNameMap.lists.get(slot.name)?.studentName ?? slot.name;
  if (slot.kind === "broadcast") return spriteNameMap.broadcasts.get(slot.name)?.studentName ?? slot.name;
  return spriteNameMap.sprites?.get(slot.value) ?? slot.value;
}

/**
 * Return a copy of an IRNode (recursively, including `.next` and `.substacks`)
 * with every variable/list/broadcast/sprite/procedure/parameter name normalised
 * via `spriteNameMap`, i.e. rewritten to the STUDENT project's equivalent name.
 *
 * Diffing already treats a renamed variable/list/sprite as equivalent (via
 * `irKey`/`collectNodeDiff`'s use of `normalizeFieldValue`/`normalizeSlotValue`),
 * but rendering a ref block on its own has no notion of the other project's
 * vocabulary. Without this, comparing the independently-rendered ref/student
 * pseudocode text for a "change" diffOp would show every renamed identifier as a
 * spurious difference, even though the diff engine already knows it's the same
 * concept. Rendering the ref side through this function first — so both lines
 * use the student's naming — makes a subsequent text/word diff highlight only
 * genuine differences.
 *
 * Pass `null`/`undefined` for `spriteNameMap` to get an unchanged (but still
 * cloned) copy — safe to call unconditionally.
 */
export function normalizeNodeForDisplay(node, spriteNameMap) {
  if (!node) return null;

  const fields = {};
  for (const [fn, val] of Object.entries(node.fields)) {
    fields[fn] = normalizeFieldValue(node, fn, val, spriteNameMap);
  }

  const inputs = {};
  for (const [name, slot] of Object.entries(node.inputs)) {
    inputs[name] = normalizeSlotForDisplay(slot, spriteNameMap);
  }

  const substacks = {};
  for (const [key, arr] of Object.entries(node.substacks)) {
    substacks[key] = normalizeSubstackForDisplay(arr, spriteNameMap);
  }

  let mutation = node.mutation;
  if (mutation) {
    const proccode = spriteNameMap?.procedures?.get(mutation.proccode)?.studentProccode ?? mutation.proccode;
    const argumentnames = mutation.argumentnames?.map((n) => spriteNameMap?.parameters?.get(n)?.studentName ?? n);
    if (proccode !== mutation.proccode || argumentnames) {
      mutation = { ...mutation, proccode, ...(argumentnames ? { argumentnames } : {}) };
    }
  }

  return {
    id: node.id,
    opcode: node.opcode,
    fields,
    inputs,
    next: normalizeNodeForDisplay(node.next, spriteNameMap),
    substacks,
    mutation,
  };
}

function normalizeSlotForDisplay(slot, spriteNameMap) {
  switch (slot.kind) {
    case "variable":
    case "list":
    case "broadcast":
      return { kind: slot.kind, name: normalizeSlotValue(slot, spriteNameMap) };
    case "literal":
      return { kind: "literal", value: normalizeSlotValue(slot, spriteNameMap), shape: slot.shape };
    case "block":
      return { kind: "block", node: normalizeNodeForDisplay(slot.node, spriteNameMap) };
    case "empty":
    default:
      return slot;
  }
}

// Normalise a substack (array of IRNodes) the same way blockToIR builds it:
// normalise the head once (recursing its own `.next` chain), then flatten that
// same chain into an array, rather than normalising each element independently.
function normalizeSubstackForDisplay(arr, spriteNameMap) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  let cur = normalizeNodeForDisplay(arr[0], spriteNameMap);
  while (cur) {
    result.push(cur);
    cur = cur.next;
  }
  return result;
}

// ─── Phase 1: Sprite Matching ─────────────────────────────────────────────────

/**
 * Match sprites in three global passes — exact name, then normalised name, then
 * Jaccard opcode-bag fallback — running EACH pass to completion across ALL ref
 * targets before starting the next. This prevents a ref target with no exact
 * counterpart (e.g. a deleted sprite) from being weakly Jaccard-matched to a
 * DIFFERENT sprite that another ref target would have matched exactly (e.g.
 * "DATA STORE" stealing "RESOURCE" via a coincidental 20% opcode overlap before
 * the real "RESOURCE" → "RESOURCE" exact match is ever attempted).
 */
function matchSprites(refProject, stuProject) {
  const refTargets = refProject.targets ?? [];
  const stuTargets = stuProject.targets ?? [];
  const matchByRef = new Map(); // refTarget → { studentTarget, confidence }
  const availableStu = new Map(stuTargets.map((t, i) => [i, t]));
  const unresolvedRefs = new Set(refTargets);

  // Pass 1: exact name match
  for (const refT of refTargets) {
    for (const [i, stuT] of availableStu) {
      if (!!stuT.isStage !== !!refT.isStage) continue;
      if (stuT.name === refT.name) {
        matchByRef.set(refT, { studentTarget: stuT, confidence: 1.0 });
        availableStu.delete(i);
        unresolvedRefs.delete(refT);
        break;
      }
    }
  }

  // Pass 2: normalised name (trim + lowercase)
  for (const refT of unresolvedRefs) {
    const normRef = refT.name.trim().toLowerCase();
    for (const [i, stuT] of availableStu) {
      if (!!stuT.isStage !== !!refT.isStage) continue;
      if (stuT.name.trim().toLowerCase() === normRef) {
        matchByRef.set(refT, { studentTarget: stuT, confidence: 0.9 });
        availableStu.delete(i);
        unresolvedRefs.delete(refT);
        break;
      }
    }
  }

  // Pass 3: Jaccard opcode-bag fallback — only for refs still unresolved after
  // exhausting exact/normalised matches for EVERY ref target.
  for (const refT of unresolvedRefs) {
    const refOpcodes = Object.values(refT.blocks ?? {})
      .filter((b) => !b.shadow)
      .map((b) => b.opcode);
    let bestIdx = -1,
      bestScore = 0,
      bestStu = null;
    for (const [i, stuT] of availableStu) {
      if (!!stuT.isStage !== !!refT.isStage) continue;
      const stuOpcodes = Object.values(stuT.blocks ?? {})
        .filter((b) => !b.shadow)
        .map((b) => b.opcode);
      const score = jaccardMultiset(refOpcodes, stuOpcodes);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestStu = stuT;
      }
    }
    if (bestStu !== null && bestScore >= 0.15) {
      matchByRef.set(refT, { studentTarget: bestStu, confidence: bestScore });
      availableStu.delete(bestIdx);
    }
  }

  // Build final results in original ref target order.
  const matches = [];
  const unmatchedRefTargets = [];
  for (const refT of refTargets) {
    const m = matchByRef.get(refT);
    if (m) matches.push({ refTarget: refT, studentTarget: m.studentTarget, confidence: m.confidence });
    else unmatchedRefTargets.push(refT);
  }

  return { matches, unmatchedRefTargets, unmatchedStudentTargets: [...availableStu.values()] };
}

// ─── Phase 2: Coarse Script Matching ─────────────────────────────────────────

function coarseMatchScriptsForSprite(refTarget, stuTarget) {
  const refBlocks = refTarget.blocks ?? {};
  const stuBlocks = stuTarget.blocks ?? {};
  const refIds = getTopLevelScriptIds(refBlocks);
  const stuIds = getTopLevelScriptIds(stuBlocks);

  const stuScripts = stuIds.map((id) => ({
    id,
    hatOpcode: stuBlocks[id]?.opcode ?? "",
    opcodes: collectOpcodes(stuBlocks, id),
  }));

  const matches = [];
  const unmatchedRefScripts = [];
  const availableStu = new Map(stuScripts.map((s, i) => [i, s]));

  for (const refId of refIds) {
    const refHatOpcode = refBlocks[refId]?.opcode ?? "";
    const refOpcodes = collectOpcodes(refBlocks, refId);

    const candidates = [];
    for (const [i, stu] of availableStu) {
      if (stu.hatOpcode === refHatOpcode) {
        candidates.push({ i, stu, score: jaccardMultiset(refOpcodes, stu.opcodes) });
      }
    }

    if (candidates.length === 0) {
      unmatchedRefScripts.push({ target: refTarget, scriptId: refId });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    matches.push({
      refTarget,
      studentTarget: stuTarget,
      refScriptId: refId,
      studentScriptId: best.stu.id,
      confidence: best.score,
    });
    availableStu.delete(best.i);
  }

  const unmatchedStudentScripts = [...availableStu.values()].map((s) => ({
    target: stuTarget,
    scriptId: s.id,
  }));
  return { matches, unmatchedRefScripts, unmatchedStudentScripts };
}

// ─── Phase 3: Name Mapping ────────────────────────────────────────────────────

/**
 * Add `weight` counts of (refName → stuName) to an evidence map.
 *
 * Weight lets higher-specificity evidence outweigh lower-specificity evidence
 * when they compete for the same name. Statement blocks with a VARIABLE/LIST
 * field (data_setvariableto, data_addtolist, etc.) are common and their
 * top-level opcode can coincidentally LCS-align with an unrelated statement
 * elsewhere in a large script, producing spurious rename evidence. Reporter
 * references (data_variable, data_itemoflist, inline type-12/13 values used
 * inside an expression) require the surrounding expression tree to also
 * structurally align, so they are much less likely to collide by coincidence
 * and are weighted more heavily.
 */
function addEvidence(evMap, refName, stuName, weight = 1) {
  if (!refName || !stuName) return;
  if (!evMap.has(refName)) evMap.set(refName, new Map());
  const ne = evMap.get(refName);
  ne.set(stuName, (ne.get(stuName) ?? 0) + weight);
}

// Reporter opcodes that reference a variable/list with high structural specificity
// (as opposed to common statement blocks like data_setvariableto / data_addtolist).
const HIGH_SPECIFICITY_VAR_OPCODES = new Set(["data_variable"]);
const HIGH_SPECIFICITY_LIST_OPCODES = new Set([
  "data_itemoflist",
  "data_itemnumoflist",
  "data_lengthoflist",
  "data_listcontainsitem",
]);
const HIGH_SPECIFICITY_WEIGHT = 3;

/**
 * Recursively walk matching input expression trees in parallel and harvest
 * VARIABLE and LIST rename evidence from variable/list slots — the IR already
 * unifies both Scratch storage formats (inline primitive vs. shadow menu block)
 * into one `{kind:"variable"|"list", name}` shape, so both are covered uniformly
 * here — and from reporter block fields. Called for each LCS-matched statement
 * node pair so that renames buried deep in expressions (e.g. car y → Car Y inside
 * an operator_add used as the ITEM of data_addtolist) are included in the NameMap
 * and therefore normalised away in irKey.
 */
function collectIRExprEvidence(refNode, stuNode, varEv, listEv, paramEv, depth) {
  if (depth <= 0 || !refNode || !stuNode || refNode.opcode !== stuNode.opcode) return;

  // procedures_call: arguments use UUID keys that differ between projects.
  // Match them positionally via mutation.argumentids instead.
  if (refNode.opcode === "procedures_call") {
    const refArgIds = refNode.mutation?.argumentids ?? [];
    const stuArgIds = stuNode.mutation?.argumentids ?? [];
    const len = Math.min(refArgIds.length, stuArgIds.length);
    for (let i = 0; i < len; i++) {
      collectSlotExprEvidence(
        refNode.inputs[refArgIds[i]],
        stuNode.inputs[stuArgIds[i]],
        varEv,
        listEv,
        paramEv,
        depth - 1
      );
    }
    return;
  }

  // Collect VARIABLE/LIST fields on this node pair itself. Reporter blocks
  // (data_variable, data_itemoflist, etc.) get a higher weight than common
  // statement blocks (data_setvariableto, data_addtolist, etc.) since they are
  // less prone to coincidental cross-script LCS collisions (see addEvidence).
  const rv = refNode.fields.VARIABLE,
    sv = stuNode.fields.VARIABLE;
  if (rv && sv)
    addEvidence(varEv, rv, sv, HIGH_SPECIFICITY_VAR_OPCODES.has(refNode.opcode) ? HIGH_SPECIFICITY_WEIGHT : 1);
  const rl = refNode.fields.LIST,
    sl = stuNode.fields.LIST;
  if (rl && sl)
    addEvidence(listEv, rl, sl, HIGH_SPECIFICITY_LIST_OPCODES.has(refNode.opcode) ? HIGH_SPECIFICITY_WEIGHT : 1);
  // Procedure parameter names live in the VALUE field of argument reporter blocks.
  // They go into a SEPARATE paramEv map so they don’t collide with sprite variables
  // that happen to share the same name (e.g. a variable 'dist' and a param 'dist').
  if (
    (refNode.opcode === "argument_reporter_string_number" || refNode.opcode === "argument_reporter_boolean") &&
    refNode.fields.VALUE &&
    stuNode.fields.VALUE
  ) {
    addEvidence(paramEv, refNode.fields.VALUE, stuNode.fields.VALUE);
    return; // argument reporters have no further inputs to walk
  }

  // Walk matching input slots. SUBSTACK/SUBSTACK2/custom_block never appear here —
  // the IR keeps them out of `inputs` entirely (see block-ir.js).
  for (const [name, refSlot] of Object.entries(refNode.inputs)) {
    const stuSlot = stuNode.inputs[name];
    if (!stuSlot) continue;
    collectSlotExprEvidence(refSlot, stuSlot, varEv, listEv, paramEv, depth - 1);
  }
}

function collectSlotExprEvidence(refSlot, stuSlot, varEv, listEv, paramEv, depth) {
  if (!refSlot || !stuSlot || refSlot.kind !== stuSlot.kind) return;
  // Variable/list refs used as VALUES inside an expression carry high structural
  // specificity (see addEvidence) regardless of storage format.
  if (refSlot.kind === "variable") addEvidence(varEv, refSlot.name, stuSlot.name, HIGH_SPECIFICITY_WEIGHT);
  else if (refSlot.kind === "list") addEvidence(listEv, refSlot.name, stuSlot.name, HIGH_SPECIFICITY_WEIGHT);
  else if (refSlot.kind === "block") collectIRExprEvidence(refSlot.node, stuSlot.node, varEv, listEv, paramEv, depth);
}

function buildNameMaps(spriteMatches, coarseScriptMatches) {
  // Collect per-sprite variable/list/parameter evidence and global broadcast evidence
  const bySprite = new Map(); // refSpriteName → {VARIABLE, LIST, PARAM}
  const globalBroadcastEv = new Map(); // refName → Map<stuName, count>

  for (const { refTarget, studentTarget } of spriteMatches) {
    const spriteEv = { VARIABLE: new Map(), LIST: new Map(), PARAM: new Map() };
    bySprite.set(refTarget.name, spriteEv);

    const spritePairs = coarseScriptMatches.filter((m) => m.refTarget === refTarget);
    const refBlocks = refTarget.blocks ?? {};
    const stuBlocks = studentTarget.blocks ?? {};

    for (const { refScriptId, studentScriptId } of spritePairs) {
      const refTokens = lineariseScriptIR(refBlocks, refScriptId);
      const stuTokens = lineariseScriptIR(stuBlocks, studentScriptId);
      if (refTokens.length === 0 || stuTokens.length === 0) continue;

      // Hat block evidence: event_whenbroadcastreceived hats are NOT linearised
      // but they carry the broadcast name as a direct BROADCAST_OPTION field.
      {
        const rBc = refBlocks[refScriptId]?.fields?.BROADCAST_OPTION?.[0];
        const sBc = stuBlocks[studentScriptId]?.fields?.BROADCAST_OPTION?.[0];
        if (rBc && sBc) addEvidence(globalBroadcastEv, rBc, sBc);
      }

      // LCS-align by opcode only (coarse), then harvest field-value pairs
      for (const op of lcsDiff(refTokens, stuTokens, (t) => t.opcode)) {
        if (op.type !== "match") continue;
        const rn = refTokens[op.ri];
        const sn = stuTokens[op.si];

        for (const fieldType of ["VARIABLE", "LIST", "BROADCAST_OPTION"]) {
          const refName = rn.fields[fieldType];
          const stuName = sn.fields[fieldType];
          if (refName === undefined || stuName === undefined) continue;
          addEvidence(fieldType === "BROADCAST_OPTION" ? globalBroadcastEv : spriteEv[fieldType], refName, stuName);
        }

        // event_broadcast / event_broadcastandwait: the IR already unifies both
        // storage formats (shadow menu block vs. inline primitive) into one
        // BROADCAST_INPUT slot, so no separate extraction helper is needed here.
        if (rn.opcode === "event_broadcast" || rn.opcode === "event_broadcastandwait") {
          const rSlot = rn.inputs.BROADCAST_INPUT;
          const sSlot = sn.inputs.BROADCAST_INPUT;
          if (rSlot?.kind === "broadcast" && sSlot?.kind === "broadcast") {
            addEvidence(globalBroadcastEv, rSlot.name, sSlot.name);
          }
        }

        // Also collect evidence from var/list refs buried in expression
        // inputs — captures renames like car y → Car Y that live inside
        // operator_add, operator_multiply etc. rather than in block fields.
        collectIRExprEvidence(rn, sn, spriteEv.VARIABLE, spriteEv.LIST, spriteEv.PARAM, 5);
      }
    }
  }

  const globalBroadcastMap = resolveEvidenceMap(
    globalBroadcastEv,
    collectFieldValues(spriteMatches, "BROADCAST_OPTION", true)
  );

  // Stage variables are global and appear in ALL sprite scripts.
  // Collect them separately so that exact-match pre-assignment works when a global
  // variable is used inside a non-stage sprite (its name won't be in the sprite's
  // own .variables dict, only in the stage's .variables dict).
  const stuStageVarNames = new Set();
  const stuStageListNames = new Set();
  for (const { studentTarget } of spriteMatches) {
    if (studentTarget.isStage) {
      for (const [name] of Object.values(studentTarget.variables ?? {})) stuStageVarNames.add(name);
      for (const [name] of Object.values(studentTarget.lists ?? {})) stuStageListNames.add(name);
    }
  }

  // Build global sprite-name map and attach to all SpriteNameMaps.
  const spritesMap = buildSpritesMap(spriteMatches);

  const nameMaps = new Map();
  for (const { refTarget, studentTarget } of spriteMatches) {
    const spriteEv = bySprite.get(refTarget.name) ?? { VARIABLE: new Map(), LIST: new Map() };
    // Combine sprite-local names with stage (global) names so that global variables
    // used inside this sprite's scripts are correctly pre-assigned as exact matches.
    const stuVarNames = new Set([
      ...Object.values(studentTarget.variables ?? {}).map(([name]) => name),
      ...stuStageVarNames,
    ]);
    const stuListNames = new Set([
      ...Object.values(studentTarget.lists ?? {}).map(([name]) => name),
      ...stuStageListNames,
    ]);
    const stuParamNames = collectParamNames(studentTarget);
    nameMaps.set(refTarget.name, {
      variables: resolveEvidenceMap(spriteEv.VARIABLE, stuVarNames),
      lists: resolveEvidenceMap(spriteEv.LIST, stuListNames),
      broadcasts: globalBroadcastMap, // shared across all sprites
      procedures: matchProcedures(refTarget, studentTarget),
      parameters: resolveEvidenceMap(spriteEv.PARAM, stuParamNames),
      sprites: spritesMap, // shared across all sprites
    });
  }
  // Let any per-sprite SpriteNameMap reach any OTHER sprite's map — needed for
  // cross-sprite lookups like sensing_of's PROPERTY (see normalizeSensingOfProperty),
  // which can read a variable belonging to a different sprite than the block itself.
  for (const nm of nameMaps.values()) nm.allNameMaps = nameMaps;
  return nameMaps;
}

// Collect all procedure parameter names used in a target's procedures.
function collectParamNames(target) {
  const names = new Set();
  for (const b of Object.values(target.blocks ?? {})) {
    if (b.opcode === "procedures_prototype" && b.shadow && b.mutation?.argumentnames) {
      try {
        for (const name of JSON.parse(b.mutation.argumentnames)) names.add(name);
      } catch {
        // malformed argumentnames — skip
      }
    }
  }
  return names;
}

// Build a global ref-sprite-name → student-sprite-name map from Phase 1 matches.
function buildSpritesMap(spriteMatches) {
  const m = new Map();
  for (const { refTarget, studentTarget } of spriteMatches) m.set(refTarget.name, studentTarget.name);
  return m;
}

// Collect all values of a specific field type across all student targets.
function collectFieldValues(spriteMatches, fieldName, allTargets) {
  const values = new Set();
  for (const { studentTarget } of spriteMatches) {
    if (!allTargets && !studentTarget) continue;
    for (const b of Object.values(studentTarget.blocks ?? {})) {
      const val = b.fields?.[fieldName]?.[0];
      if (val !== undefined) values.add(val);
    }
  }
  return values;
}

/**
 * Given an evidence map {refName → Map<stuName, count>}, resolve to a bijection.
 *
 * Two-pass:
 *  Pass 1 — Exact matches: if the student project has a name identical to the
 *           ref name, assign it unconditionally (confidence 1.0). This prevents
 *           a variable that exists with the same name in both projects from being
 *           stolen by a weak evidence match on another variable.
 *  Pass 2 — Greedy: for remaining ref names, assign the highest-count available
 *           student name, minimum 40% confidence.
 *
 * @param {Map} evidenceMap   refName → Map<stuName, count>
 * @param {Set} [stuNames]    full set of student names (for exact pre-matching)
 */
function resolveEvidenceMap(evidenceMap, stuNames = null) {
  const result = new Map();
  const usedStudentNames = new Set();

  // Pass 1: exact name matches — the same name in both projects is always itself.
  for (const refName of evidenceMap.keys()) {
    if (stuNames ? stuNames.has(refName) : evidenceMap.get(refName).has(refName)) {
      if (!usedStudentNames.has(refName)) {
        result.set(refName, { studentName: refName, confidence: 1.0, isRename: false });
        usedStudentNames.add(refName);
      }
    }
  }

  // Pass 2: greedy evidence-based matching for remaining ref names.
  const remaining = [...evidenceMap.keys()]
    .filter((rn) => !result.has(rn))
    .sort((a, b) => {
      const aMax = Math.max(...evidenceMap.get(a).values());
      const bMax = Math.max(...evidenceMap.get(b).values());
      return bMax - aMax;
    });

  for (const refName of remaining) {
    const nameEv = evidenceMap.get(refName);
    const total = [...nameEv.values()].reduce((s, v) => s + v, 0);

    let bestStu = null,
      bestCount = 0;
    for (const [stuName, count] of nameEv) {
      if (!usedStudentNames.has(stuName) && count > bestCount) {
        bestCount = count;
        bestStu = stuName;
      }
    }

    if (bestStu !== null && bestStu !== undefined && bestCount / total >= 0.4) {
      result.set(refName, {
        studentName: bestStu,
        confidence: bestCount / total,
        isRename: bestStu !== refName,
      });
      usedStudentNames.add(bestStu);
    }
  }
  return result;
}

// ─── Procedure matching (part of Phase 3) ────────────────────────────────────

function matchProcedures(refTarget, stuTarget) {
  const result = new Map();
  const refBlocks = refTarget.blocks ?? {};
  const stuBlocks = stuTarget.blocks ?? {};

  const refProcs = collectProcdefs(refBlocks);
  const stuProcs = collectProcdefs(stuBlocks);
  const usedStu = new Set();

  for (const [refProccode, refDefId] of refProcs) {
    const refPattern = proccodePattern(refProccode);
    const refBody = collectOpcodes(refBlocks, refDefId);

    const candidates = [];
    for (const [stuProccode, stuDefId] of stuProcs) {
      if (usedStu.has(stuProccode)) continue;
      if (proccodePattern(stuProccode) !== refPattern) continue;
      const stuBody = collectOpcodes(stuBlocks, stuDefId);
      candidates.push({ stuProccode, score: jaccardMultiset(refBody, stuBody) });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score >= 0.1) {
      result.set(refProccode, {
        studentProccode: best.stuProccode,
        confidence: best.score,
        isRename: best.stuProccode !== refProccode,
      });
      usedStu.add(best.stuProccode);
    }
  }
  return result;
}

function collectProcdefs(blocks) {
  const procs = new Map();
  for (const [id, b] of Object.entries(blocks)) {
    if (b.opcode !== "procedures_definition" || b.shadow) continue;
    const protoInput = b.inputs?.["custom_block"];
    const protoId = typeof protoInput?.[1] === "string" ? protoInput[1] : null;
    const proto = protoId ? blocks[protoId] : null;
    if (proto?.mutation?.proccode) procs.set(proto.mutation.proccode, id);
  }
  return procs;
}

function proccodePattern(proccode) {
  return (proccode.match(/%[snb]/g) ?? []).join("");
}

// ─── Phase 4: Refined Script Matching ────────────────────────────────────────

/**
 * Re-match scripts using NameMap to normalise hat field values.
 * Primarily improves disambiguation of same-hat scripts (e.g. two "on receive"
 * scripts) where the broadcast name is the only distinguishing factor.
 */
function refinedMatchScriptsForSprite(refTarget, stuTarget, spriteNameMap) {
  const refBlocks = refTarget.blocks ?? {};
  const stuBlocks = stuTarget.blocks ?? {};
  const refIds = getTopLevelScriptIds(refBlocks);
  const stuIds = getTopLevelScriptIds(stuBlocks);

  // Build a "hat key" that includes opcode + normalised hat fields.
  // For the ref side we normalise broadcast names via the NameMap so that
  // "on receive [spawn-enemies]" matches "on receive [make-enemies]" when
  // the NameMap maps spawn-enemies → make-enemies.
  function hatKey(blocks, id, nameMap) {
    const b = blocks[id];
    if (!b) return "";
    const parts = [b.opcode];
    for (const [k, v] of Object.entries(b.fields ?? {})) {
      let val = v[0] ?? "";
      if (nameMap && k === "BROADCAST_OPTION") {
        val = nameMap.broadcasts.get(val)?.studentName ?? val;
      }
      parts.push(`${k}=${val}`);
    }
    return parts.sort().join("|");
  }

  const stuScripts = stuIds.map((id) => ({
    id,
    key: hatKey(stuBlocks, id, null),
    opcodes: collectOpcodes(stuBlocks, id),
  }));

  const matches = [];
  const unmatchedRefScripts = [];
  const availableStu = new Map(stuScripts.map((s, i) => [i, s]));

  for (const refId of refIds) {
    const refKey = hatKey(refBlocks, refId, spriteNameMap);
    const refOpcodes = collectOpcodes(refBlocks, refId);

    // Prefer candidates with matching normalised hat key
    let candidates = [];
    for (const [i, stu] of availableStu) {
      if (stu.key === refKey) {
        candidates.push({ i, stu, score: jaccardMultiset(refOpcodes, stu.opcodes) });
      }
    }

    // Fall back to hat-opcode-only matching if no key match
    if (candidates.length === 0) {
      const refHatOpcode = refBlocks[refId]?.opcode ?? "";
      for (const [i, stu] of availableStu) {
        if ((stuBlocks[stu.id]?.opcode ?? "") === refHatOpcode) {
          candidates.push({ i, stu, score: jaccardMultiset(refOpcodes, stu.opcodes) });
        }
      }
    }

    if (candidates.length === 0) {
      unmatchedRefScripts.push({ target: refTarget, scriptId: refId });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    matches.push({
      refTarget,
      studentTarget: stuTarget,
      refScriptId: refId,
      studentScriptId: best.stu.id,
      confidence: best.score,
    });
    availableStu.delete(best.i);
  }

  const unmatchedStudentScripts = [...availableStu.values()].map((s) => ({
    target: stuTarget,
    scriptId: s.id,
  }));
  return { matches, unmatchedRefScripts, unmatchedStudentScripts };
}

// ─── Phase 5: Block-level Diff ────────────────────────────────────────────────

/**
 * Recursively diff two IRNodes assumed to share the same opcode (established by
 * the caller via LCS-by-opcode + an irKey mismatch), collecting every differing
 * field/input into `changes` (Map<path, {ref, student}>) — however deep, unlike
 * the pre-IR changedFields walker, which was capped at one extra level into a
 * direct non-shadow input child (see DIFF-IR-PLAN.md Phase 2). Only differences
 * we can describe as a single directly-renderable string (a literal value, or a
 * variable/list/broadcast/parameter name — even across a change of kind, e.g. a
 * variable reference replaced by a hardcoded literal, or a procedure's own
 * parameter replaced by a same-named variable — see simpleSlotValue) are
 * recorded; genuine structural changes (a nested reporter replaced by a value
 * of a different shape, or two nested reporters with different opcodes — e.g.
 * `(A*B)*C` reassociated to `A*(B*C)`) are intentionally left unrecorded:
 * there's no simple string to safely highlight for those without a pseudocode
 * renderer for the subtree (see Phase 3). The overall match/mismatch decision
 * for the pair is already handled independently by irKey, so under-recording
 * here only affects how much of a "change" we can explain, never whether one
 * was detected.
 */
function collectNodeDiff(path, refNode, stuNode, spriteNameMap, changes) {
  for (const [fn, refVal] of Object.entries(refNode.fields)) {
    const stuVal = stuNode.fields[fn] ?? "";
    const normRef = normalizeFieldValue(refNode, fn, refVal, spriteNameMap);
    if (normRef !== stuVal) changes.set(joinPath(path, fn), { ref: refVal, student: stuVal });
  }
  for (const [fn, stuVal] of Object.entries(stuNode.fields)) {
    if (!(fn in refNode.fields)) changes.set(joinPath(path, fn), { ref: "", student: stuVal });
  }

  // procedures_call: arguments use UUID keys that differ between projects — match
  // them positionally via mutation.argumentids instead of by input-slot name.
  if (refNode.opcode === "procedures_call" && stuNode.opcode === "procedures_call") {
    const refArgIds = refNode.mutation?.argumentids ?? [];
    const stuArgIds = stuNode.mutation?.argumentids ?? [];
    const len = Math.min(refArgIds.length, stuArgIds.length);
    for (let i = 0; i < len; i++) {
      collectSlotDiff(
        joinPath(path, `arg${i}`),
        refNode.inputs[refArgIds[i]],
        stuNode.inputs[stuArgIds[i]],
        spriteNameMap,
        changes
      );
    }
    return;
  }

  const inputNames = new Set([...Object.keys(refNode.inputs), ...Object.keys(stuNode.inputs)]);
  for (const name of inputNames) {
    collectSlotDiff(joinPath(path, name), refNode.inputs[name], stuNode.inputs[name], spriteNameMap, changes);
  }
}

function joinPath(base, segment) {
  return base ? `${base}.${segment}` : segment;
}

// Reporter opcodes for a procedure's own parameter blocks — the ONLY "real
// block" (non-inline-primitive) shape that still renders as a single bare name
// in pseudocode, just like a variable/list reference (see INLINE_FORMATTERS'
// argument_reporter_string_number/_boolean entries in userscript.js).
const PARAMETER_REPORTER_OPCODES = new Set(["argument_reporter_string_number", "argument_reporter_boolean"]);

// A slot's directly-renderable value (matches what appears verbatim in the
// pseudocode text), or null if it isn't one (a nested reporter, or empty). A
// procedure parameter reference is included here — despite being a real nested
// block, not an inline primitive — since it renders as a single bare name just
// like a variable/list reference, so a parameter swapped for a same-named
// variable/list/literal is exactly the "renamed identifier" case this function
// already handles for the other simple kinds.
function simpleSlotValue(slot) {
  if (slot.kind === "literal") return slot.value;
  if (slot.kind === "variable" || slot.kind === "list" || slot.kind === "broadcast") return slot.name;
  if (slot.kind === "block" && PARAMETER_REPORTER_OPCODES.has(slot.node.opcode)) return slot.node.fields.VALUE ?? "";
  return null;
}

// A short label for what a "simple" slot (see simpleSlotValue) actually refers
// to. Used to catch a change that's invisible in rendered pseudocode text — a
// procedure's own parameter swapped for a same-named variable renders
// identically (both are just the bare name "dir"), but is a real bug: the
// value no longer comes from the parameter, it comes from a variable that may
// not even be in scope the way the author intended.
function simpleSlotKindLabel(slot) {
  if (slot.kind === "block") return "parameter";
  return slot.kind; // "variable" | "list" | "broadcast" | "literal"
}

function collectSlotDiff(path, refSlot, stuSlot, spriteNameMap, changes) {
  refSlot = refSlot ?? { kind: "empty" };
  stuSlot = stuSlot ?? { kind: "empty" };

  const refSimple = simpleSlotValue(refSlot);
  const stuSimple = simpleSlotValue(stuSlot);
  if (refSimple !== null && stuSimple !== null) {
    const normRef = normalizeSlotValue(refSlot, spriteNameMap);
    if (normRef !== stuSimple) {
      changes.set(path, { ref: refSimple, student: stuSimple });
    } else if (simpleSlotKindLabel(refSlot) !== simpleSlotKindLabel(stuSlot)) {
      // Same displayed name, different underlying reference (e.g. a "dir"
      // parameter replaced by a "dir" variable) — label both sides so the
      // difference survives even though the two sides render identically.
      const refLabel = simpleSlotKindLabel(refSlot);
      const stuLabel = simpleSlotKindLabel(stuSlot);
      changes.set(path, { ref: `${refLabel} "${refSimple}"`, student: `${stuLabel} "${stuSimple}"` });
    }
    return;
  }

  if (refSlot.kind === "block" && stuSlot.kind === "block" && refSlot.node.opcode === stuSlot.node.opcode) {
    collectNodeDiff(path, refSlot.node, stuSlot.node, spriteNameMap, changes);
  }
  // Otherwise: a genuine structural change (nested reporter ↔ simple value, two
  // reporters with different opcodes, or a slot filled/emptied) — see doc comment
  // on collectNodeDiff above for why this is intentionally not recorded.
}

/**
 * Compute a block-level diff for a matched script pair.
 * LCS on opcode sequence; matched pairs are then checked for field-value
 * changes (after NameMap normalisation, via a recursive IR tree-diff). A
 * post-processing pass then detects statements that simply moved to a
 * different position (see markMovedPairs). Returns DiffOp[].
 */
function diffScriptBody(refTarget, stuTarget, refScriptId, stuScriptId, spriteNameMap) {
  const refBlocks = refTarget.blocks ?? {};
  const stuBlocks = stuTarget.blocks ?? {};
  const refTokens = lineariseScriptIR(refBlocks, refScriptId);
  const stuTokens = lineariseScriptIR(stuBlocks, stuScriptId);

  if (refTokens.length === 0 && stuTokens.length === 0) return [];

  const ops = lcsDiff(refTokens, stuTokens, (t) => t.opcode).map((op) => {
    const refNode = op.ri >= 0 ? refTokens[op.ri] : null;
    const stuNode = op.si >= 0 ? stuTokens[op.si] : null;
    const opcode = refNode?.opcode ?? stuNode?.opcode;
    const refBlockId = refNode?.id ?? null;
    const stuBlockId = stuNode?.id ?? null;
    const refDepth = refNode?.depth ?? null;
    const studentDepth = stuNode?.depth ?? null;

    if (op.type !== "match") {
      return {
        type: op.type,
        refBlockId,
        studentBlockId: stuBlockId,
        opcode,
        changedFields: null,
        refDepth,
        studentDepth,
      };
    }

    // Same opcode — check whether the two subtrees agree after normalisation.
    if (irKey(refNode, spriteNameMap) === irKey(stuNode, null)) {
      return {
        type: "match",
        refBlockId,
        studentBlockId: stuBlockId,
        opcode,
        changedFields: null,
        refDepth,
        studentDepth,
      };
    }

    // Something differs — collect which fields/inputs changed, at any depth.
    const changedFields = new Map();
    collectNodeDiff("", refNode, stuNode, spriteNameMap, changedFields);

    // Always "change" when the key differs — changedFields may be null if the
    // difference is a structural one we can't safely describe as a simple string
    // (see collectNodeDiff doc comment).
    return {
      type: "change",
      refBlockId,
      studentBlockId: stuBlockId,
      opcode,
      changedFields: changedFields.size > 0 ? changedFields : null,
      refDepth,
      studentDepth,
    };
  });

  const refById = new Map(refTokens.map((t) => [t.id, t]));
  const stuById = new Map(stuTokens.map((t) => [t.id, t]));
  markMovedPairs(ops, refById, stuById, spriteNameMap);
  markSwappedPairs(ops, refById, stuById, spriteNameMap);

  return ops;
}

/**
 * Mutate `ops` in place: for every unmatched "delete"/"insert" pair whose
 * IRNodes have an IDENTICAL irKey (same opcode, same normalised fields/inputs —
 * i.e. truly the same statement, not just a coincidentally-matching opcode), mark
 * both with `moved: true` plus a cross-reference to the other's block ID.
 *
 * Pure LCS-based diffing can't represent "this statement moved" directly — a
 * reordering breaks the longest-common-subsequence property, since preserving
 * relative order is exactly what LCS optimises for — so a relocated statement
 * (with no other change) surfaces as an unrelated delete-at-its-old-position plus
 * insert-at-its-new-position instead of a "match". Without this pass, that looks
 * like a no-op (identical text appears to be both removed and added) even though
 * the reorder itself can be a meaningful behavioural change in Scratch (execution
 * order matters). Greedy first-match pairing by key; a moved statement with a
 * genuine ALSO-different field is still just paired with the first available
 * matching key — good enough since exact duplicates are the common case this
 * targets, not proving a single canonical reordering exists.
 */
function markMovedPairs(ops, refById, stuById, spriteNameMap) {
  const inserts = ops.filter((op) => op.type === "insert");
  const usedInserts = new Set();

  for (const del of ops) {
    if (del.type !== "delete") continue;
    const refNode = refById.get(del.refBlockId);
    if (!refNode) continue;
    const key = irKey(refNode, spriteNameMap);
    for (const ins of inserts) {
      if (usedInserts.has(ins)) continue;
      const stuNode = stuById.get(ins.studentBlockId);
      if (!stuNode || irKey(stuNode, null) !== key) continue;
      del.moved = true;
      del.movedToBlockId = ins.studentBlockId;
      ins.moved = true;
      ins.movedFromBlockId = del.refBlockId;
      usedInserts.add(ins);
      break;
    }
  }
}

/**
 * Mutate `ops` in place: for every adjacent pair of "change" ops with the same
 * opcode, mark both `swapped: true` if swapping their values would make each
 * side an EXACT match for the other (same opcode, same normalised fields/inputs)
 * — i.e. these are really the same two statements, just assigned to each
 * other's position, not a genuine field-level change.
 *
 * LCS aligns same-opcode statements by position, so two adjacent statements
 * that simply swapped order (e.g. `set effect to BRIGHTNESS` / `set effect to
 * GHOST` becoming `GHOST` / `BRIGHTNESS`) surface as two unrelated "change" ops
 * instead of a "match" — each looking like a real field edit when nothing
 * actually changed except execution order. This only flags EXACT swaps (see
 * markMovedPairs for the equivalent delete/insert case); a pair that also has a
 * genuine value difference (e.g. one side's value additionally changed) is
 * correctly left as two separate "change" ops, since swapping wouldn't make
 * them identical.
 */
function markSwappedPairs(ops, refById, stuById, spriteNameMap) {
  for (let i = 0; i < ops.length - 1; i++) {
    const a = ops[i];
    const b = ops[i + 1];
    if (a.type !== "change" || b.type !== "change" || a.opcode !== b.opcode) continue;
    const aRef = refById.get(a.refBlockId);
    const aStu = stuById.get(a.studentBlockId);
    const bRef = refById.get(b.refBlockId);
    const bStu = stuById.get(b.studentBlockId);
    if (!aRef || !aStu || !bRef || !bStu) continue;
    if (irKey(aRef, spriteNameMap) === irKey(bStu, null) && irKey(aStu, null) === irKey(bRef, spriteNameMap)) {
      a.swapped = true;
      a.swappedPrimary = true;
      b.swapped = true;
    }
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export function diffProjects(refProject, stuProject) {
  // Phase 1: Sprite matching
  const { matches: spriteMatches, unmatchedRefTargets, unmatchedStudentTargets } = matchSprites(refProject, stuProject);

  // Phase 2: Coarse script matching (opcode-only)
  const allCoarseMatches = [];
  for (const { refTarget, studentTarget } of spriteMatches) {
    allCoarseMatches.push(...coarseMatchScriptsForSprite(refTarget, studentTarget).matches);
  }

  // Phase 3: Name mapping (informed by coarse script pairs)
  const nameMaps = buildNameMaps(spriteMatches, allCoarseMatches);

  // Phase 4: Refined script matching (with NameMap)
  const scriptMatches = [];
  const unmatchedRefScripts = [];
  const unmatchedStudentScripts = [];

  for (const { refTarget, studentTarget } of spriteMatches) {
    const spriteNameMap = nameMaps.get(refTarget.name) ?? {
      variables: new Map(),
      lists: new Map(),
      broadcasts: new Map(),
      procedures: new Map(),
    };
    const result = refinedMatchScriptsForSprite(refTarget, studentTarget, spriteNameMap);
    scriptMatches.push(...result.matches);
    unmatchedRefScripts.push(...result.unmatchedRefScripts);
    unmatchedStudentScripts.push(...result.unmatchedStudentScripts);
  }

  // Scripts in unmatched sprites are all missing / extra
  for (const refT of unmatchedRefTargets) {
    for (const id of getTopLevelScriptIds(refT.blocks ?? {})) {
      unmatchedRefScripts.push({ target: refT, scriptId: id });
    }
  }
  for (const stuT of unmatchedStudentTargets) {
    for (const id of getTopLevelScriptIds(stuT.blocks ?? {})) {
      unmatchedStudentScripts.push({ target: stuT, scriptId: id });
    }
  }

  // Phase 5: Block-level diff for each matched script pair
  for (const match of scriptMatches) {
    const spriteNameMap = nameMaps.get(match.refTarget.name) ?? {
      variables: new Map(),
      lists: new Map(),
      broadcasts: new Map(),
      procedures: new Map(),
    };
    match.diffOps = diffScriptBody(
      match.refTarget,
      match.studentTarget,
      match.refScriptId,
      match.studentScriptId,
      spriteNameMap
    );
  }

  return {
    spriteMatches,
    unmatchedRefTargets,
    unmatchedStudentTargets,
    nameMaps,
    scriptMatches,
    unmatchedRefScripts,
    unmatchedStudentScripts,
  };
}
