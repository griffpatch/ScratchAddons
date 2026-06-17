/**
 * ast-to-blocks.js
 *
 * Converts an AST from parsePseudocode() into a flat array of Scratch VM
 * block objects suitable for vm.shareBlocksToTarget(blocks, targetId).
 *
 * Exports:
 *   astToBlocks(scripts, vm?) → BlockObject[]
 *
 * The `vm` argument is optional. When provided, variable/list IDs are resolved
 * from the editing target so the injected blocks bind to existing variables.
 * Without it, variable fields carry null IDs (the VM will create new vars).
 */

import { parseExpr } from "./pseudocode-parser.js";

// ─── ID generation ────────────────────────────────────────────────────────────

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%()*+,-./:;=?@[]^_`{|}~";
function uid() {
  let id = "";
  for (let i = 0; i < 20; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  return id;
}

// ─── Shadow / input-slot type table ──────────────────────────────────────────
// Maps input slot name → { opcode, field, defaultValue } for shadow blocks.
// null means the slot is boolean (no shadow in Scratch).

const NUMERIC = { opcode: "math_number", field: "NUM", defaultValue: "0" };
const POSNUM = { opcode: "math_positive_number", field: "NUM", defaultValue: "10" };
const WHOLE = { opcode: "math_whole_number", field: "NUM", defaultValue: "1" };
const ANGLE = { opcode: "math_angle", field: "NUM", defaultValue: "90" };
const STRING = { opcode: "text", field: "TEXT", defaultValue: "" };
const COLOR = { opcode: "colour_picker", field: "COLOUR", defaultValue: "#ff0000" };
const BOOL = null; // boolean slots have no shadow

const SLOT_SHADOWS = {
  // Motion
  STEPS: POSNUM,
  DEGREES: ANGLE,
  DIRECTION: ANGLE,
  X: NUMERIC,
  Y: NUMERIC,
  DX: NUMERIC,
  DY: NUMERIC,
  SECS: POSNUM,
  // Looks
  MESSAGE: STRING,
  SIZE: POSNUM,
  NUM: WHOLE,
  CHANGE: NUMERIC,
  EFFECT: STRING,
  COLOR: COLOR,
  // Sound
  VOLUME: NUMERIC,
  // Control
  TIMES: WHOLE,
  DURATION: POSNUM,
  CONDITION: BOOL,
  OPERAND: BOOL,
  // OPERAND1/OPERAND2 are intentionally NOT listed as BOOL here: comparison operators
  // (operator_gt, operator_equals, etc.) use those same slot names with round reporters.
  // The coercion below only fires for CONDITION and OPERAND (the true gate slots).
  OPERAND1: NUMERIC,
  OPERAND2: NUMERIC,
  // Data
  VALUE: NUMERIC,
  INDEX: WHOLE,
  ITEM: STRING,
  // Operators
  NUM1: NUMERIC,
  NUM2: NUMERIC,
  STRING1: STRING,
  STRING2: STRING,
  STRING: STRING,
  LETTER: WHOLE,
  FROM: NUMERIC,
  TO: NUMERIC,
  // Sensing
  QUESTION: STRING,
  // Events
  BROADCAST_INPUT: STRING,
};

function slotShadow(inputName) {
  if (inputName in SLOT_SHADOWS) return SLOT_SHADOWS[inputName];
  return NUMERIC; // fallback for unknown slots
}

// ─── Variable / list ID resolver ─────────────────────────────────────────────

function resolveVarId(fieldName, varName, vm) {
  if (!vm || !varName || !fieldName) return null;
  if (fieldName !== "VARIABLE" && fieldName !== "LIST" && fieldName !== "BROADCAST_OPTION") return null;

  const search = (target) => {
    for (const [id, v] of Object.entries(target?.variables ?? {})) {
      if (v.name === varName) return id;
    }
    return null;
  };

  const id = search(vm.editingTarget) ?? search(vm.runtime?.getTargetForStage?.()) ?? null;

  return id;
}

// ─── Field builder ────────────────────────────────────────────────────────────

function buildFields(astFields, vm) {
  const result = {};
  for (const [fieldName, pair] of Object.entries(astFields ?? {})) {
    const [value, existingId] = Array.isArray(pair) ? pair : [pair, null];
    const resolvedId = existingId ?? resolveVarId(fieldName, value, vm);
    result[fieldName] = { name: fieldName, value: value ?? "" };
    if (resolvedId) result[fieldName].id = resolvedId;
    // blockToXML includes `variabletype="..."` only if this property is set.
    // Blockly's deserializer defaults the expected type to "" when the attribute
    // is absent, so LIST fields (type "list") must declare it explicitly.
    if (fieldName === "LIST") result[fieldName].variableType = "list";
    else if (fieldName === "VARIABLE") result[fieldName].variableType = "";
  }
  return result;
}

// ─── Input node builder ───────────────────────────────────────────────────────
// Returns { entry: {block, shadow}, extraBlocks: [] }

function buildInputEntry(inputName, inputNode, parentId, vm) {
  const extraBlocks = [];
  const shadowInfo = slotShadow(inputName);
  // name must be included so blockToXML can emit <value name="..."> correctly
  const mkEntry = (block, shadow) => ({ name: inputName, block, shadow });

  if (!inputNode || inputNode.kind === "unknown") {
    // Empty slot — leave both block and shadow null (no crash, just empty input)
    return { entry: mkEntry(null, null), extraBlocks };
  }

  // Unresolved variable reporter in a string slot → treat as string literal.
  // This handles common AI output like `say (Hello)` where (Hello) is parsed
  // as a data_variable but the name isn't an actual variable in the project.
  if (inputNode.kind === "reporter" && inputNode.opcode === "data_variable" && shadowInfo?.opcode === "text") {
    const varName = inputNode.fields?.VARIABLE?.[0] ?? "";
    if (!resolveVarId("VARIABLE", varName, vm)) {
      inputNode = { kind: "literal", value: varName };
    }
  }

  if (inputNode.kind === "literal") {
    if (!shadowInfo) {
      // Boolean slot with a literal value — unusual; pass as empty
      return { entry: mkEntry(null, null), extraBlocks };
    }
    const shadowId = uid();
    extraBlocks.push({
      id: shadowId,
      opcode: shadowInfo.opcode,
      next: null,
      parent: parentId,
      inputs: {},
      fields: {
        [shadowInfo.field]: { name: shadowInfo.field, value: String(inputNode.value ?? shadowInfo.defaultValue) },
      },
      shadow: true,
      topLevel: false,
      x: 0,
      y: 0,
    });
    return { entry: mkEntry(shadowId, shadowId), extraBlocks };
  }

  // If a true boolean gate slot (CONDITION or OPERAND) receives a round reporter,
  // coerce it to `reporter > 0` so Scratch accepts a diamond-shaped block.
  // OPERAND1/OPERAND2 are excluded — comparison operators use those with reporters.
  const isBoolGateSlot = inputName === "CONDITION" || inputName === "OPERAND";
  if (isBoolGateSlot && inputNode.kind === "reporter") {
    inputNode = {
      kind: "boolean",
      opcode: "operator_gt",
      fields: {},
      inputs: {
        OPERAND1: inputNode,
        OPERAND2: { kind: "literal", value: "0" },
      },
    };
  }

  // Reporter or boolean — build recursively
  const reporterBlock = buildReporter(inputNode, parentId, extraBlocks, vm);
  if (!reporterBlock) return { entry: mkEntry(null, null), extraBlocks };

  // Create a background shadow for the slot (not for boolean slots)
  let shadowId = null;
  if (shadowInfo) {
    shadowId = uid();
    extraBlocks.push({
      id: shadowId,
      opcode: shadowInfo.opcode,
      next: null,
      parent: parentId,
      inputs: {},
      fields: { [shadowInfo.field]: { name: shadowInfo.field, value: shadowInfo.defaultValue } },
      shadow: true,
      topLevel: false,
      x: 0,
      y: 0,
    });
  }

  return { entry: mkEntry(reporterBlock.id, shadowId), extraBlocks };
}

// ─── Reporter builder ─────────────────────────────────────────────────────────

function buildReporter(node, parentId, blocks, vm) {
  if (!node || !node.opcode) return null;
  // unknown_* opcodes are parse failures — skip rather than injecting invalid blocks
  // that would crash Blockly's XML deserializer on refreshWorkspace().
  if (node.opcode.startsWith("unknown_")) return null;

  const id = uid();
  const block = {
    id,
    opcode: node.opcode,
    next: null,
    parent: parentId,
    inputs: {},
    fields: buildFields(node.fields, vm),
    shadow: false,
    topLevel: false,
    x: 0,
    y: 0,
  };

  for (const [inputName, inputNode] of Object.entries(node.inputs ?? {})) {
    if (!inputNode) continue;
    const { entry, extraBlocks } = buildInputEntry(inputName, inputNode, id, vm);
    block.inputs[inputName] = entry;
    blocks.push(...extraBlocks);
  }

  blocks.push(block);
  return block;
}

// ─── Statement builder ────────────────────────────────────────────────────────
// Returns { firstId, lastId } (same for plain statements)

function buildStatement(node, vm, blocks) {
  const id = uid();
  const block = {
    id,
    opcode: node.opcode,
    next: null,
    parent: null, // set by linkSequence
    inputs: {},
    fields: buildFields(node.fields, vm),
    shadow: false,
    topLevel: false,
    x: 0,
    y: 0,
  };

  if (node.opcode === "procedures_call") {
    // Parse the raw proccode to extract argument values, e.g.:
    //   "fast sort (lo) ((i) - (1))" -> proccode "fast sort %s %s", args ["lo", "(i) - (1)"]
    // We also try to find an existing definition in the VM to reuse its argumentids,
    // so the call actually connects to the defined block.
    const rawProccode = node.proccode ?? node.raw ?? "";
    const argValues = [];
    const encodedProccode = rawProccode.replace(
      /(\(([^()]*(?:\([^()]*\)[^()]*)*)\))|("([^"]*)"|\[([^\]]+)\])/g,
      (_m, _paren, parenInner, _quoted, quotedInner, bracketInner) => {
        const val = parenInner ?? quotedInner ?? bracketInner ?? "";
        argValues.push(val.trim());
        return "%s";
      }
    );

    // Try to find the definition block in the VM to reuse its argumentids
    let argIds = argValues.map(() => uid());
    if (vm) {
      const allBlocks = vm.editingTarget?.blocks?._blocks ?? {};
      for (const b of Object.values(allBlocks)) {
        if (b.opcode === "procedures_prototype" && b.mutation?.proccode === encodedProccode) {
          try {
            argIds = JSON.parse(b.mutation.argumentids);
          } catch (_) {}
          break;
        }
      }
    }

    block.mutation = {
      tagName: "mutation",
      children: [],
      proccode: encodedProccode,
      argumentids: JSON.stringify(argIds),
      warp: "false",
    };

    // Build an input block for each argument value
    for (let k = 0; k < argValues.length; k++) {
      const argNode = parseExpr(argValues[k]).node ?? { kind: "literal", value: argValues[k] };
      const { entry, extraBlocks } = buildInputEntry(argIds[k], argNode, id, vm);
      // Override the name on the entry to be the argId (not the inputName param)
      entry.name = argIds[k];
      block.inputs[argIds[k]] = entry;
      blocks.push(...extraBlocks);
    }
  }

  for (const [inputName, inputNode] of Object.entries(node.inputs ?? {})) {
    if (!inputNode) continue;
    const { entry, extraBlocks } = buildInputEntry(inputName, inputNode, id, vm);
    block.inputs[inputName] = entry;
    blocks.push(...extraBlocks);
  }

  blocks.push(block);
  return { firstId: id, lastId: id };
}

// ─── C-block builder ──────────────────────────────────────────────────────────
// Returns { firstId, lastId } — both are the c-block's own ID since it is
// the single block at this level of the outer sequence.

function buildCBlock(node, vm, blocks) {
  const id = uid();
  const block = {
    id,
    opcode: node.opcode,
    next: null,
    parent: null, // set by linkSequence
    inputs: {},
    fields: buildFields(node.fields, vm),
    shadow: false,
    topLevel: false,
    x: 0,
    y: 0,
  };

  // Condition / TIMES inputs
  for (const [inputName, inputNode] of Object.entries(node.inputs ?? {})) {
    if (!inputNode) continue;
    const { entry, extraBlocks } = buildInputEntry(inputName, inputNode, id, vm);
    block.inputs[inputName] = entry;
    blocks.push(...extraBlocks);
  }

  // SUBSTACK (main body)
  if (node.body?.length > 0) {
    const result = buildSequence(node.body, vm, blocks);
    if (result) {
      block.inputs.SUBSTACK = { name: "SUBSTACK", block: result.firstId, shadow: null };
      const firstInner = blocks.find((b) => b.id === result.firstId);
      if (firstInner) firstInner.parent = id;
    }
  }

  // SUBSTACK2 (else branch)
  if (node.elseBody?.length > 0) {
    const result = buildSequence(node.elseBody, vm, blocks);
    if (result) {
      block.inputs.SUBSTACK2 = { name: "SUBSTACK2", block: result.firstId, shadow: null };
      const firstInner = blocks.find((b) => b.id === result.firstId);
      if (firstInner) firstInner.parent = id;
    }
  }

  blocks.push(block);
  return { firstId: id, lastId: id };
}

// ─── Node dispatcher ──────────────────────────────────────────────────────────

function buildNode(node, vm, blocks) {
  if (!node) return null;
  if (node.type === "statement") return buildStatement(node, vm, blocks);
  if (node.type === "c-block") return buildCBlock(node, vm, blocks);
  return null; // unknown / extension
}

// ─── Sequence builder & linker ────────────────────────────────────────────────
// Returns { firstId, lastId } or null.

function buildSequence(body, vm, blocks) {
  const results = [];
  for (const node of body) {
    const r = buildNode(node, vm, blocks);
    if (r) results.push(r);
  }
  if (results.length === 0) return null;

  // Link next/parent for adjacent nodes in the sequence.
  // For each pair (curr, next): curr's last block's .next = next's firstId,
  // and next's first block's .parent = curr's lastId.
  for (let i = 0; i < results.length - 1; i++) {
    const currLast = blocks.find((b) => b.id === results[i].lastId);
    const nextFirst = blocks.find((b) => b.id === results[i + 1].firstId);
    if (currLast) currLast.next = results[i + 1].firstId;
    if (nextFirst) nextFirst.parent = results[i].lastId;
  }

  return { firstId: results[0].firstId, lastId: results[results.length - 1].lastId };
}

// ─── Script builder ───────────────────────────────────────────────────────────

function buildScript(script, x, y, vm) {
  const blocks = [];
  let hatId = null;

  if (script.hat) {
    hatId = uid();
    const hat = {
      id: hatId,
      opcode: script.hat.opcode,
      next: null,
      parent: null,
      inputs: {},
      fields: buildFields(script.hat.fields, vm),
      shadow: false,
      topLevel: true,
      x,
      y,
    };

    if (script.hat.opcode === "procedures_definition") {
      // Parse the proccode to extract parameter names and build proper Scratch mutation.
      // Scratch encodes string params as "%s" and boolean params as "%b" in the proccode.
      // LLM often writes: define sort (listName)  →  proccode "sort (listName)"
      // We convert each (paramName) to %s and build the argumentids/argumentnames arrays.
      const rawProccode = script.hat.proccode ?? "";
      const argIds = [];
      const argNames = [];
      const argDefaults = [];
      // Match both (param) and "param" styles — LLMs sometimes write define sort "list"
      // instead of define sort (list). Both become string parameters (%s).
      const encodedProccode = rawProccode.replace(/\(([^)]+)\)|("([^"]+)")/g, (_match, parenParam, _q, quotedParam) => {
        const paramName = (parenParam ?? quotedParam ?? "").trim();
        argIds.push(uid());
        argNames.push(paramName);
        argDefaults.push("");
        return "%s";
      });

      const protoId = uid();
      // Build argument reporter blocks (shadow: true) as inputs to the prototype.
      // Each parameter needs an argument_reporter_string_number block so that the
      // parameter appears inside the define block's hat shape. Without these, Blockly
      // may serialize/deserialize the block incorrectly.
      const protoInputs = {};
      for (let ai = 0; ai < argIds.length; ai++) {
        const argReporterId = uid();
        blocks.push({
          id: argReporterId,
          opcode: "argument_reporter_string_number",
          next: null,
          parent: protoId,
          inputs: {},
          fields: { VALUE: { name: "VALUE", value: argNames[ai] } },
          shadow: true,
          topLevel: false,
          x: 0,
          y: 0,
        });
        protoInputs[argIds[ai]] = { name: argIds[ai], block: argReporterId, shadow: argReporterId };
      }
      const proto = {
        id: protoId,
        opcode: "procedures_prototype",
        next: null,
        parent: hatId,
        inputs: protoInputs,
        fields: {},
        shadow: true,
        topLevel: false,
        x: 0,
        y: 0,
        mutation: {
          tagName: "mutation",
          children: [],
          proccode: encodedProccode,
          argumentids: JSON.stringify(argIds),
          argumentnames: JSON.stringify(argNames),
          argumentdefaults: JSON.stringify(argDefaults),
          warp: script.hat.warp ? "true" : "false",
        },
      };
      blocks.push(proto);
      // Blockly expects the input name "custom_block" (lowercase) for the prototype slot
      hat.inputs.custom_block = { name: "custom_block", block: protoId, shadow: protoId };
    } else {
      for (const [inputName, inputNode] of Object.entries(script.hat.inputs ?? {})) {
        if (!inputNode) continue;
        const { entry, extraBlocks } = buildInputEntry(inputName, inputNode, hatId, vm);
        hat.inputs[inputName] = entry;
        blocks.push(...extraBlocks);
      }
    }

    blocks.push(hat);
  }

  if (script.body.length > 0) {
    const bodyResult = buildSequence(script.body, vm, blocks);
    if (bodyResult) {
      if (hatId) {
        const hatBlock = blocks.find((b) => b.id === hatId);
        if (hatBlock) hatBlock.next = bodyResult.firstId;
        const firstBody = blocks.find((b) => b.id === bodyResult.firstId);
        if (firstBody) firstBody.parent = hatId;
      } else {
        // Hatless script — promote first block to topLevel
        const firstBlock = blocks.find((b) => b.id === bodyResult.firstId);
        if (firstBlock) {
          firstBlock.topLevel = true;
          firstBlock.x = x;
          firstBlock.y = y;
        }
      }
    }
  }

  return blocks;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert an array of Script ASTs (from parsePseudocode) into a flat array
 * of Scratch VM block objects ready for vm.shareBlocksToTarget().
 *
 * @param {object[]} scripts  The scripts array from parsePseudocode().
 * @param {object}  [vm]      Optional Scratch VM instance for variable ID lookup.
 * @param {number}  [startX]  X position of first script (default 50).
 * @param {number}  [startY]  Y position of first script (default 50).
 * @returns {object[]}  Flat array of VM block objects.
 */
export function astToBlocks(scripts, vm, startX = 50, startY = 50) {
  const all = [];
  let y = startY;
  for (const script of scripts) {
    const scriptBlocks = buildScript(script, startX, y, vm);
    all.push(...scriptBlocks);
    y += 300;
  }
  return all;
}
