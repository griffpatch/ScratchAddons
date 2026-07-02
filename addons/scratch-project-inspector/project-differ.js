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
 *
 * DiffOp: { type: 'match'|'insert'|'delete'|'change',
 *            refBlockId, studentBlockId, opcode, changedFields }
 */

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

// ─── Script linearisation ─────────────────────────────────────────────────────

/**
 * Flatten a script body into a list of tokens in pseudocode reading order
 * (C-block header → substack body → next — matching renderSequence order).
 * The hat block itself is NOT included.
 * Returns [{id, opcode, block}]
 */
function lineariseScript(blocks, hatId) {
  const tokens = [];
  function visitSeq(id) {
    let cur = id;
    while (cur) {
      const b = blocks[cur];
      if (!b || b.shadow) break;
      tokens.push({ id: cur, opcode: b.opcode, block: b });
      for (const name of ["SUBSTACK", "SUBSTACK2"]) {
        const sub = b.inputs?.[name];
        if (sub && typeof sub[1] === "string") visitSeq(sub[1]);
      }
      cur = b.next;
    }
  }
  const hat = blocks[hatId];
  if (hat?.next) visitSeq(hat.next);
  return tokens;
}

// ─── Block name key ───────────────────────────────────────────────────────────

/**
 * Build a string key for a block that captures opcode + field values + a compact
 * description of immediate input slots (up to 2 levels deep into non-shadow
 * reporter blocks). Optionally normalises variable/list/broadcast names via a
 * SpriteNameMap.
 *
 * Going 2 levels deep catches bugs like:
 *   data_addtolist LIST=TRACK Y  whose ITEM input is  data_itemoflist LIST=TRACK X
 * …where the top-level field is correct but the reporter child's field is wrong.
 *
 * Also catches cases like  (item (track idx) of [TRACK Y])  vs  (item (1) of [TRACK Y])
 * in matched scripts, where the INDEX input of data_itemoflist differs.
 */
function blockNameKey(block, blocks, spriteNameMap) {
  function normName(fn, val) {
    if (!spriteNameMap) return val;
    if (fn === "VARIABLE") return spriteNameMap.variables.get(val)?.studentName ?? val;
    if (fn === "LIST") return spriteNameMap.lists.get(val)?.studentName ?? val;
    if (fn === "BROADCAST_OPTION") return spriteNameMap.broadcasts.get(val)?.studentName ?? val;
    // Procedure parameter names stored in argument reporter VALUE fields are tracked
    // in a separate parameters NameMap to avoid collision with sprite variables that
    // happen to share the same name (e.g. a variable 'dist' and a param 'dist' are
    // independent namespaces in Scratch).
    if (fn === "VALUE") return spriteNameMap.parameters?.get(val)?.studentName ?? val;
    return val;
  }

  // Compact description of an input slot, up to `depth` levels deep.
  // Captures inline primitives, shadow default values, and non-shadow reporter chains.
  function describeSlot(inputArr, depth) {
    const [, primary] = inputArr ?? [];
    if (Array.isArray(primary)) {
      // Inline primitive [type, value]
      const [type, value] = primary;
      if (type === 12) return `var(${normName("VARIABLE", String(value ?? ""))})`;
      if (type === 13) return `list(${normName("LIST", String(value ?? ""))})`; // Inline broadcast ref (type 11): use bc() prefix to match shadow BROADCAST_OPTION
      if (type === 11) return `bc(${normName("BROADCAST_OPTION", String(value ?? ""))})`;
      return `lit(${type}:${value ?? ""})`;
    }
    if (typeof primary !== "string" || !blocks) return null;
    const child = blocks[primary];
    if (!child) return null;
    if (child.shadow) {
      const entries = Object.entries(child.fields ?? {});
      if (entries.length > 0) {
        const [fieldName, fieldVal] = entries[0];
        let val = fieldVal[0] ?? "";
        if (fieldName === "BROADCAST_OPTION") {
          // Use bc() prefix (same as inline type-11) so both storage formats produce
          // the same key and can be matched across projects.
          const normalized = spriteNameMap?.broadcasts?.get(val)?.studentName ?? val;
          return `bc(${normalized})`;
        }
        if (spriteNameMap) val = spriteNameMap.sprites?.get(val) ?? val;
        return `shad(${val})`;
      }
      return "shad";
    }
    // Non-shadow reporter: include opcode + its own fields
    let d = child.opcode;
    for (const [fn, fv] of Object.entries(child.fields ?? {})) {
      d += `:${fn}=${normName(fn, fv[0] ?? "")}`;
    }
    // Recurse into the child's own inputs (decrement depth)
    if (depth > 0) {
      for (const [iName, inp] of Object.entries(child.inputs ?? {})) {
        if (iName === "SUBSTACK" || iName === "SUBSTACK2" || iName === "custom_block") continue;
        const nested = describeSlot(inp, depth - 1);
        if (nested) d += `[${iName}:${nested}]`;
      }
    }
    return d;
  }

  const parts = [block.opcode];

  // procedures_call: the proccode lives in mutation (not fields) and argument IDs
  // are UUIDs that differ between projects. Key on normalised proccode + positional
  // argument descriptions instead of the default field+input approach.
  if (block.opcode === "procedures_call" && block.mutation) {
    const proccode = block.mutation.proccode ?? "";
    const normalizedProccode = spriteNameMap?.procedures.get(proccode)?.studentProccode ?? proccode;
    const argIds = JSON.parse(block.mutation.argumentids ?? "[]");
    const k = [`procedures_call:${normalizedProccode}`];
    if (blocks) {
      for (let i = 0; i < argIds.length; i++) {
        const inp = block.inputs?.[argIds[i]];
        if (inp) {
          const desc = describeSlot(inp, 2);
          if (desc) k.push(`arg${i}=${desc}`);
        }
      }
    }
    return k.join("|");
  }

  // Top-level fields
  for (const [fn, fv] of Object.entries(block.fields ?? {})) {
    parts.push(`${fn}=${normName(fn, fv[0] ?? "")}`);
  }

  // Non-substack input slots (described 2 levels deep — the immediate input child
  // is described including its own inputs, which are each described 1 further level.
  // 2 levels from root means 3 total levels of nesting are visible, catching bugs like
  // (item (track idx) of [TRACK Y]) vs (item (1) of [TRACK Y]) where the INDEX of
  // data_itemoflist is 3 levels down from the enclosing data_setvariableto statement.)
  if (blocks) {
    for (const [iName, inp] of Object.entries(block.inputs ?? {})) {
      if (iName === "SUBSTACK" || iName === "SUBSTACK2" || iName === "custom_block") continue;
      const desc = describeSlot(inp, 2);
      if (desc) parts.push(`${iName}=${desc}`);
    }
  }

  return parts.join("|");
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

/**
 * Extract a broadcast name from a BROADCAST_INPUT input array, handling both
 * storage formats used by Scratch:
 *   - Shadow block: [1, menuBlockId]  where menuBlock.fields.BROADCAST_OPTION = [name]
 *   - Inline ref:   [1, [11, name, id]]
 */
function extractBroadcastName(blocks, inputArr) {
  if (!inputArr) return null;
  const [, primary] = inputArr;
  if (Array.isArray(primary) && primary[0] === 11) return String(primary[1] ?? "");
  if (typeof primary === "string") return blocks[primary]?.fields?.BROADCAST_OPTION?.[0] ?? null;
  return null;
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
 * VARIABLE and LIST rename evidence from inline primitives (type 12/13) and
 * reporter block fields.  Called for each LCS-matched statement block pair
 * so that renames buried deep in expressions (e.g. car y → Car Y inside an
 * operator_add used as the ITEM of data_addtolist) are included in the NameMap
 * and therefore normalised away in blockNameKey.
 */
function collectExprEvidence(refBlocks, stuBlocks, refBlockId, stuBlockId, varEv, listEv, paramEv, depth) {
  if (depth <= 0) return;
  const rb = refBlocks[refBlockId],
    sb = stuBlocks[stuBlockId];
  if (!rb || !sb || rb.shadow || sb.shadow || rb.opcode !== sb.opcode) return;

  // procedures_call: arguments use UUID keys that differ between projects.
  // Match them positionally via mutation.argumentids instead.
  if (rb.opcode === "procedures_call") {
    const refArgIds = JSON.parse(rb.mutation?.argumentids ?? "[]");
    const stuArgIds = JSON.parse(sb.mutation?.argumentids ?? "[]");
    const len = Math.min(refArgIds.length, stuArgIds.length);
    for (let i = 0; i < len; i++) {
      const rInp = rb.inputs?.[refArgIds[i]];
      const sInp = sb.inputs?.[stuArgIds[i]];
      if (!rInp || !sInp) continue;
      const [, rPri] = rInp,
        [, sPri] = sInp;
      if (Array.isArray(rPri) && Array.isArray(sPri)) {
        if (rPri[0] === 12 && sPri[0] === 12)
          addEvidence(varEv, String(rPri[1] ?? ""), String(sPri[1] ?? ""), HIGH_SPECIFICITY_WEIGHT);
        else if (rPri[0] === 13 && sPri[0] === 13)
          addEvidence(listEv, String(rPri[1] ?? ""), String(sPri[1] ?? ""), HIGH_SPECIFICITY_WEIGHT);
      } else if (typeof rPri === "string" && typeof sPri === "string") {
        const rChild = refBlocks[rPri],
          sChild = stuBlocks[sPri];
        if (rChild && sChild && !rChild.shadow && !sChild.shadow) {
          collectExprEvidence(refBlocks, stuBlocks, rPri, sPri, varEv, listEv, paramEv, depth - 1);
        }
      }
    }
    return;
  }

  // Collect VARIABLE/LIST fields on this block pair itself. Reporter blocks
  // (data_variable, data_itemoflist, etc.) get a higher weight than common
  // statement blocks (data_setvariableto, data_addtolist, etc.) since they are
  // less prone to coincidental cross-script LCS collisions (see addEvidence).
  const rv = rb.fields?.VARIABLE?.[0],
    sv = sb.fields?.VARIABLE?.[0];
  if (rv && sv) addEvidence(varEv, rv, sv, HIGH_SPECIFICITY_VAR_OPCODES.has(rb.opcode) ? HIGH_SPECIFICITY_WEIGHT : 1);
  const rl = rb.fields?.LIST?.[0],
    sl = sb.fields?.LIST?.[0];
  if (rl && sl) addEvidence(listEv, rl, sl, HIGH_SPECIFICITY_LIST_OPCODES.has(rb.opcode) ? HIGH_SPECIFICITY_WEIGHT : 1);
  // Procedure parameter names live in the VALUE field of argument reporter blocks.
  // They go into a SEPARATE paramEv map so they don’t collide with sprite variables
  // that happen to share the same name (e.g. a variable 'dist' and a param 'dist').
  if (
    (rb.opcode === "argument_reporter_string_number" || rb.opcode === "argument_reporter_boolean") &&
    rb.fields?.VALUE?.[0] &&
    sb.fields?.VALUE?.[0]
  ) {
    addEvidence(paramEv, rb.fields.VALUE[0], sb.fields.VALUE[0]);
    return; // argument reporters have no further inputs to walk
  }

  // Walk matching input slots
  for (const [iName, rInp] of Object.entries(rb.inputs ?? {})) {
    if (iName === "SUBSTACK" || iName === "SUBSTACK2" || iName === "custom_block") continue;
    const sInp = sb.inputs?.[iName];
    if (!sInp) continue;
    const [, rPri] = rInp;
    const [, sPri] = sInp;

    // Both inline variable (12) or list (13) refs? These are used as VALUES
    // inside an expression, so they carry high structural specificity.
    if (Array.isArray(rPri) && Array.isArray(sPri) && rPri[0] === sPri[0]) {
      if (rPri[0] === 12) addEvidence(varEv, String(rPri[1] ?? ""), String(sPri[1] ?? ""), HIGH_SPECIFICITY_WEIGHT);
      else if (rPri[0] === 13)
        addEvidence(listEv, String(rPri[1] ?? ""), String(sPri[1] ?? ""), HIGH_SPECIFICITY_WEIGHT);
    }

    // Both non-shadow block references → recurse
    if (typeof rPri === "string" && typeof sPri === "string") {
      const rChild = refBlocks[rPri],
        sChild = stuBlocks[sPri];
      if (rChild && sChild && !rChild.shadow && !sChild.shadow) {
        collectExprEvidence(refBlocks, stuBlocks, rPri, sPri, varEv, listEv, paramEv, depth - 1);
      }
    }
  }
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
      const refTokens = lineariseScript(refBlocks, refScriptId);
      const stuTokens = lineariseScript(stuBlocks, studentScriptId);
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
        const rb = refTokens[op.ri].block;
        const sb = stuTokens[op.si].block;

        for (const fieldType of ["VARIABLE", "LIST", "BROADCAST_OPTION"]) {
          const refName = rb.fields?.[fieldType]?.[0];
          const stuName = sb.fields?.[fieldType]?.[0];
          if (refName === null || refName === undefined || stuName === null || stuName === undefined) continue;

          const evMap = fieldType === "BROADCAST_OPTION" ? globalBroadcastEv : spriteEv[fieldType];
          if (!evMap.has(refName)) evMap.set(refName, new Map());
          const nameEv = evMap.get(refName);
          nameEv.set(stuName, (nameEv.get(stuName) ?? 0) + 1);
        }

        // event_broadcast / event_broadcastandwait: the broadcast name lives in a
        // shadow menu child (BROADCAST_OPTION field) or as an inline type-11 primitive.
        // Use a helper to extract the name from either format independently, so that
        // mixed-format pairs (ref=shadow, student=inline or vice versa) also work.
        if (rb.opcode === "event_broadcast" || rb.opcode === "event_broadcastandwait") {
          const rBc = extractBroadcastName(refBlocks, rb.inputs?.BROADCAST_INPUT);
          const sBc = extractBroadcastName(stuBlocks, sb.inputs?.BROADCAST_INPUT);
          if (rBc && sBc) addEvidence(globalBroadcastEv, rBc, sBc);
        }

        // Also collect evidence from inline var/list refs buried in expression
        // inputs — captures renames like car y → Car Y that live inside
        // operator_add, operator_multiply etc. rather than in block fields.
        collectExprEvidence(
          refBlocks,
          stuBlocks,
          refTokens[op.ri].id,
          stuTokens[op.si].id,
          spriteEv.VARIABLE,
          spriteEv.LIST,
          spriteEv.PARAM,
          5
        );
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
 * Compute a block-level diff for a matched script pair.
 * LCS on opcode sequence; matched pairs are then checked for field-value
 * changes (after NameMap normalisation). Returns DiffOp[].
 */
function diffScriptBody(refTarget, stuTarget, refScriptId, stuScriptId, spriteNameMap) {
  const refBlocks = refTarget.blocks ?? {};
  const stuBlocks = stuTarget.blocks ?? {};
  const refTokens = lineariseScript(refBlocks, refScriptId);
  const stuTokens = lineariseScript(stuBlocks, stuScriptId);

  if (refTokens.length === 0 && stuTokens.length === 0) return [];

  return lcsDiff(refTokens, stuTokens, (t) => t.opcode).map((op) => {
    const refBlockId = op.ri >= 0 ? refTokens[op.ri].id : null;
    const stuBlockId = op.si >= 0 ? stuTokens[op.si].id : null;
    const opcode = op.ri >= 0 ? refTokens[op.ri].opcode : stuTokens[op.si].opcode;

    if (op.type !== "match") {
      return { type: op.type, refBlockId, studentBlockId: stuBlockId, opcode, changedFields: null };
    }

    // Same opcode — check whether field values agree after normalisation
    const rb = refTokens[op.ri].block;
    const sb = stuTokens[op.si].block;

    if (blockNameKey(rb, refBlocks, spriteNameMap) === blockNameKey(sb, stuBlocks, null)) {
      return { type: "match", refBlockId, studentBlockId: stuBlockId, opcode, changedFields: null };
    }

    // Something differs — collect which fields changed (top-level and input-level).
    const changedFields = new Map();

    // Top-level block fields
    for (const [fn, fv] of Object.entries(rb.fields ?? {})) {
      let normRefVal = fv[0] ?? "";
      if (spriteNameMap) {
        if (fn === "VARIABLE") normRefVal = spriteNameMap.variables.get(normRefVal)?.studentName ?? normRefVal;
        else if (fn === "LIST") normRefVal = spriteNameMap.lists.get(normRefVal)?.studentName ?? normRefVal;
        else if (fn === "BROADCAST_OPTION")
          normRefVal = spriteNameMap.broadcasts.get(normRefVal)?.studentName ?? normRefVal;
      }
      const stuVal = sb.fields?.[fn]?.[0] ?? "";
      if (normRefVal !== stuVal) changedFields.set(fn, { ref: fv[0] ?? "", student: stuVal });
    }
    for (const [fn, fv] of Object.entries(sb.fields ?? {})) {
      if (!(fn in (rb.fields ?? {}))) changedFields.set(fn, { ref: "", student: fv[0] ?? "" });
    }

    // Input-level reporter field changes (e.g. data_itemoflist reading wrong list)
    for (const [inputName, input] of Object.entries(rb.inputs ?? {})) {
      if (inputName === "SUBSTACK" || inputName === "SUBSTACK2" || inputName === "custom_block") continue;
      const refChildId = typeof input[1] === "string" ? input[1] : null;
      const stuInput = sb.inputs?.[inputName];
      const stuChildId = stuInput && typeof stuInput[1] === "string" ? stuInput[1] : null;
      if (!refChildId || !stuChildId) continue;
      const refChild = refBlocks[refChildId];
      const stuChild = stuBlocks[stuChildId];
      if (!refChild || !stuChild || refChild.shadow || stuChild.shadow) continue;
      for (const [fn, fv] of Object.entries(refChild.fields ?? {})) {
        if (fn !== "VARIABLE" && fn !== "LIST") continue;
        let normRefVal = fv[0] ?? "";
        if (spriteNameMap) {
          if (fn === "VARIABLE") normRefVal = spriteNameMap.variables.get(normRefVal)?.studentName ?? normRefVal;
          else if (fn === "LIST") normRefVal = spriteNameMap.lists.get(normRefVal)?.studentName ?? normRefVal;
        }
        const stuVal = stuChild.fields?.[fn]?.[0] ?? "";
        if (normRefVal !== stuVal) changedFields.set(`${inputName}.${fn}`, { ref: fv[0] ?? "", student: stuVal });
      }
    }

    // Always "change" when the key differs — changedFields may be null if the
    // difference is only visible at deeper nesting than we scan.
    return {
      type: "change",
      refBlockId,
      studentBlockId: stuBlockId,
      opcode,
      changedFields: changedFields.size > 0 ? changedFields : null,
    };
  });
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
