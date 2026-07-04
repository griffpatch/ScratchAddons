/**
 * block-ir.js
 *
 * Builds a canonical, shadow-free intermediate representation (IR) directly from
 * live Scratch VM block JSON (`target.blocks`). See DIFF-IR-PLAN.md for the design
 * rationale (Phase 1). Nothing else in the addon consumes this module yet — it's
 * introduced standalone so later phases can migrate onto it without behaviour change.
 *
 * Exports:
 *   blockToIR(blockId, blocksDict) → IRNode | null
 *   scriptToIR(hatBlockId, blocksDict) → IRNode | null   (alias of blockToIR, named
 *                                                          for use at script hats)
 *
 * IRNode:
 *   {
 *     id,                    // the real, live block ID (never a shadow's ID)
 *     opcode,
 *     fields: { name: value },
 *     inputs: { name: InputSlot },
 *     next: IRNode | null,
 *     substacks: { SUBSTACK?: IRNode[], SUBSTACK2?: IRNode[] },
 *     mutation: DecodedMutation | null,
 *   }
 *
 * InputSlot is a discriminated union — one shape for every kind of value a Scratch
 * input slot can hold, collapsing Scratch's two competing storage formats (a shadow
 * block with a field vs. an inline type-11/12/13 primitive) into one:
 *   { kind: "literal", value, shape }                 — any number/string/color;
 *                                                        shape is "number" | "colour"
 *                                                        | "string" | "menu" (a plain
 *                                                        shadow dropdown, e.g. a
 *                                                        costume/sound/target menu) —
 *                                                        needed by renderers to pick
 *                                                        bracket style; diffing can
 *                                                        ignore it and compare `value`.
 *   { kind: "variable" | "list" | "broadcast", name }  — either storage format
 *   { kind: "block", node: IRNode }                    — a real nested reporter
 *   { kind: "empty" }                                  — nothing plugged in
 *
 * Shadow blocks NEVER become their own IRNode — they're absorbed into the parent's
 * InputSlot as a plain value. No shadow IDs, x/y, or `shadow:true` noise surfaces in
 * the IR, and only REAL (non-shadow) blocks carry an `id` for highlight/navigation.
 *
 * DecodedMutation: same shape as a raw block's `mutation`, except `argumentids`,
 * `argumentnames`, and `argumentdefaults` are parsed into real arrays (they're
 * JSON-encoded strings in the raw format) instead of requiring callers to
 * `JSON.parse()` them repeatedly.
 */

// Inline primitive type codes used in sb3 "compressed" input arrays
// (e.g. inputs.VALUE = [1, [12, "myVar", "varId"]]).
const INLINE_VARIABLE = 12;
const INLINE_LIST = 13;
const INLINE_BROADCAST = 11;
const INLINE_COLOUR = 9;
const INLINE_STRING = 10;
// Types 4 (number), 5 (positive number), 6 (positive integer), 7 (integer), and 8
// (angle) all share the "number" shape — the specific numeric subtype doesn't matter
// for diffing or pseudocode rendering, only the value and whether it's a plain number,
// a colour, or a string (which affects bracket style — see `literalShape` below).

function literalShape(type) {
  if (type === INLINE_COLOUR) return "colour";
  if (type === INLINE_STRING) return "string";
  return "number"; // 4, 5, 6, 7, 8, and any other/unknown numeric-ish type
}

function decodeMutation(mutation) {
  if (!mutation) return null;
  const decoded = { ...mutation };
  for (const key of ["argumentids", "argumentnames", "argumentdefaults"]) {
    if (typeof mutation[key] !== "string") continue;
    try {
      decoded[key] = JSON.parse(mutation[key]);
    } catch {
      decoded[key] = [];
    }
  }
  return decoded;
}

// Extract the block-id reference out of a raw input array ([shadowStatus, primary,
// shadow?]), or null if the primary value isn't a block reference (e.g. it's an
// inline primitive, or the slot is empty).
function rawChildId(inputArr) {
  const primary = inputArr?.[1];
  return typeof primary === "string" ? primary : null;
}

// Build the InputSlot for a single raw input array (e.g. block.inputs.VALUE).
function inputSlotFromRaw(inputArr, blocksDict) {
  if (!inputArr) return { kind: "empty" };
  const [, primary] = inputArr;

  if (Array.isArray(primary)) {
    // Inline primitive: [type, value] (literal) or [type, name, id] (var/list/bc).
    const [type, value] = primary;
    if (type === INLINE_VARIABLE) return { kind: "variable", name: String(value ?? "") };
    if (type === INLINE_LIST) return { kind: "list", name: String(value ?? "") };
    if (type === INLINE_BROADCAST) return { kind: "broadcast", name: String(value ?? "") };
    return { kind: "literal", value: value ?? "", shape: literalShape(type) };
  }

  if (typeof primary !== "string") return { kind: "empty" };
  const child = blocksDict[primary];
  if (!child) return { kind: "empty" };

  if (child.shadow) {
    // Shadows never become their own IRNode — absorb their single field into a
    // literal/variable/list/broadcast value on the parent's slot instead.
    const entries = Object.entries(child.fields ?? {});
    if (entries.length === 0) return { kind: "empty" };
    const [fieldName, fieldVal] = entries[0];
    const value = fieldVal[0] ?? "";
    if (fieldName === "VARIABLE") return { kind: "variable", name: value };
    if (fieldName === "LIST") return { kind: "list", name: value };
    if (fieldName === "BROADCAST_OPTION") return { kind: "broadcast", name: value };
    // Any other shadow field is a plain dropdown/menu selection (e.g. a costume,
    // sound, or target-sprite picker) — rendered bare, with brackets (if any) added
    // by the caller, unlike inline number/colour/string literals which self-bracket.
    return { kind: "literal", value, shape: "menu" };
  }

  // Real (non-shadow) reporter block — recurse.
  return { kind: "block", node: blockToIR(primary, blocksDict) };
}

// Follow a substack's block-chain (already built once via blockToIR's own `next`
// recursion) and flatten it into an array, reusing the same IRNode objects rather
// than rebuilding them — each array element's `.next` still points to the next one.
function scriptBodyToIR(startId, blocksDict) {
  const nodes = [];
  let cur = startId ? blockToIR(startId, blocksDict) : null;
  while (cur) {
    nodes.push(cur);
    cur = cur.next;
  }
  return nodes;
}

/**
 * Convert a single real block (by id) into an IRNode. `blockId` must reference a
 * non-shadow block in `blocksDict` — shadow blocks are never converted directly,
 * they're absorbed by `inputSlotFromRaw` on their parent's side.
 */
export function blockToIR(blockId, blocksDict) {
  const block = blocksDict[blockId];
  if (!block) return null;

  const fields = {};
  for (const [name, value] of Object.entries(block.fields ?? {})) {
    fields[name] = value[0] ?? "";
  }

  const inputs = {};
  const substacks = {};
  for (const [name, inputArr] of Object.entries(block.inputs ?? {})) {
    if (name === "SUBSTACK" || name === "SUBSTACK2") {
      substacks[name] = scriptBodyToIR(rawChildId(inputArr), blocksDict);
      continue;
    }
    // procedures_prototype (the shadow "signature" block referenced by a
    // procedures_definition's custom_block input) carries no useful field or
    // expression data of its own — its proccode/argumentnames mutation is promoted
    // onto the enclosing procedures_definition's own `mutation` below instead, so
    // callers don't need to know about this Scratch-internal indirection.
    if (name === "custom_block") continue;
    inputs[name] = inputSlotFromRaw(inputArr, blocksDict);
  }

  let mutation = decodeMutation(block.mutation);
  if (block.opcode === "procedures_definition" && !mutation) {
    const protoId = rawChildId(block.inputs?.custom_block);
    const proto = protoId ? blocksDict[protoId] : null;
    mutation = decodeMutation(proto?.mutation);
  }

  return {
    id: blockId,
    opcode: block.opcode,
    fields,
    inputs,
    next: typeof block.next === "string" ? blockToIR(block.next, blocksDict) : null,
    substacks,
    mutation,
  };
}

/**
 * Convert a top-level script (hat block + its body) into an IRNode rooted at the hat.
 * The hat node's own `next` chain represents the script body, matching
 * `lineariseScript()`'s traversal order in project-differ.js. This is just a named
 * alias of `blockToIR` for readability at call sites that mean "a whole script",
 * rather than "one block".
 */
export function scriptToIR(hatBlockId, blocksDict) {
  return blockToIR(hatBlockId, blocksDict);
}
