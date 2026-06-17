/**
 * Unit tests for pseudocode-parser.js
 * Run with: npm run test:local
 *
 * Coverage intent:
 *  - Basic expression types (literals, variables, arithmetic, list ops)
 *  - Boolean expressions (comparisons, <=/>= rewrites, and/or/not)
 *  - Complex nested conditions actually produced by LLMs
 *  - LLM-specific quirks: double-wrapped parens, missing outer brackets,
 *    arithmetic inside list indices, bare variable names in conditions
 *  - Hat blocks, statements, c-blocks (all common types)
 *  - Comment stripping, meta-line filtering, sprite headers
 *  - Stop / break aliases
 *  - Procedures definition + call with complex args
 *  - Multiple scripts in one input
 */
import { describe, it, expect } from "vitest";
import { parseExpr, parsePseudocode } from "../addons/scratch-project-inspector/pseudocode-parser.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const variable = (name) => ({
  kind: "reporter",
  opcode: "data_variable",
  inputs: {},
  fields: { VARIABLE: [name, null] },
});

const literal = (value) => ({ kind: "literal", value: String(value) });

const bool = (opcode, inputs, fields = {}) => ({
  kind: "boolean",
  opcode,
  inputs,
  fields,
});

const reporter = (opcode, inputs, fields = {}) => ({
  kind: "reporter",
  opcode,
  inputs,
  fields,
});

const lt = (a, b) => bool("operator_lt", { OPERAND1: a, OPERAND2: b });
const gt = (a, b) => bool("operator_gt", { OPERAND1: a, OPERAND2: b });
const eq = (a, b) => bool("operator_equals", { OPERAND1: a, OPERAND2: b });
const and = (a, b) => bool("operator_and", { OPERAND1: a, OPERAND2: b });
const or = (a, b) => bool("operator_or", { OPERAND1: a, OPERAND2: b });
const not = (a) => bool("operator_not", { OPERAND: a });
const lte = (a, b) => not(gt(a, b)); // <= → not(a > b)
const gte = (a, b) => not(lt(a, b)); // >= → not(a < b)

const itemOfList = (index, listName) => reporter("data_itemoflist", { INDEX: index }, { LIST: [listName, null] });

const lenOfList = (listName) => reporter("data_lengthoflist", {}, { LIST: [listName, null] });

const add = (a, b) => reporter("operator_add", { NUM1: a, NUM2: b }, {});
const sub = (a, b) => reporter("operator_subtract", { NUM1: a, NUM2: b }, {});
const mul = (a, b) => reporter("operator_multiply", { NUM1: a, NUM2: b }, {});
const div_ = (a, b) => reporter("operator_divide", { NUM1: a, NUM2: b }, {});

const noUnknowns = (scripts) => {
  const check = (node) => {
    if (!node || typeof node !== "object") return;
    expect(node.opcode ?? "").not.toMatch(/^unknown_/);
    for (const v of Object.values(node.inputs ?? {})) check(v);
    for (const v of Object.values(node.fields ?? {})) {
      /* skip */
    }
    for (const v of node.body ?? []) check(v);
    for (const v of node.elseBody ?? []) check(v);
  };
  for (const s of scripts) {
    check(s.hat);
    s.body.forEach(check);
  }
};

// ─── parseExpr — literals ─────────────────────────────────────────────────────

describe("parseExpr — literals", () => {
  it("parses integer literal", () => {
    expect(parseExpr("(5)").node).toMatchObject(literal("5"));
  });
  it("parses negative literal", () => {
    expect(parseExpr("(-3)").node).toMatchObject(literal("-3"));
  });
  it("parses float literal", () => {
    expect(parseExpr("(3.14)").node).toMatchObject(literal("3.14"));
  });
  it("parses string literal in brackets", () => {
    const node = parseExpr("[Hello World]").node;
    expect(node.kind).toBe("literal");
    expect(node.value).toBe("Hello World");
  });
});

// ─── parseExpr — variables ────────────────────────────────────────────────────

describe("parseExpr — variables", () => {
  it("parses simple variable", () => {
    expect(parseExpr("(i)").node).toMatchObject(variable("i"));
  });
  it("parses multi-word variable", () => {
    const node = parseExpr("(my var)").node;
    expect(node).toMatchObject({ kind: "reporter", opcode: "data_variable" });
    expect(node.fields.VARIABLE[0]).toBe("my var");
  });
  it("strips [v] dropdown marker from variable name", () => {
    const node = parseExpr("(my var v)").node;
    expect(node.fields.VARIABLE[0]).toBe("my var");
  });
  it("double-wrapped parens unwrap to variable", () => {
    // LLMs sometimes write ((i)) when they mean (i)
    const node = parseExpr("((i))").node;
    expect(node).toMatchObject(variable("i"));
  });
});

// ─── parseExpr — arithmetic ───────────────────────────────────────────────────

describe("parseExpr — arithmetic", () => {
  it("parses addition", () => {
    expect(parseExpr("((i) + (1))").node).toMatchObject(add(variable("i"), literal("1")));
  });
  it("parses subtraction", () => {
    expect(parseExpr("((hi) - (1))").node).toMatchObject(sub(variable("hi"), literal("1")));
  });
  it("parses multiplication", () => {
    expect(parseExpr("((a) * (b))").node).toMatchObject(mul(variable("a"), variable("b")));
  });
  it("parses division", () => {
    expect(parseExpr("((a) / (b))").node).toMatchObject(div_(variable("a"), variable("b")));
  });
  it("parses nested arithmetic: ((i) + (1)) used as list index", () => {
    const node = parseExpr("(item ((i) + (1)) of [my list])").node;
    expect(node.opcode).toBe("data_itemoflist");
    expect(node.inputs.INDEX).toMatchObject(add(variable("i"), literal("1")));
  });
  it("parses (length of [list]) as an expression", () => {
    expect(parseExpr("(length of [my list])").node).toMatchObject(lenOfList("my list"));
  });
  it("parses ((i) + (1)) in a procedures_call arg", () => {
    // Used in: quicksort ((i) + (1)) (hi)
    const node = parseExpr("((i) + (1))").node;
    expect(node).toMatchObject(add(variable("i"), literal("1")));
  });
});

// ─── parseExpr — list reporters ───────────────────────────────────────────────

describe("parseExpr — list reporters", () => {
  it("parses item N of [list]", () => {
    expect(parseExpr("(item (i) of [my list])").node).toMatchObject(itemOfList(variable("i"), "my list"));
  });
  it("parses item with arithmetic index", () => {
    const node = parseExpr("(item ((i) + (1)) of [my list])").node;
    expect(node.opcode).toBe("data_itemoflist");
    expect(node.inputs.INDEX).toMatchObject(add(variable("i"), literal("1")));
  });
  it("parses length of [list]", () => {
    expect(parseExpr("(length of [my list])").node).toMatchObject(lenOfList("my list"));
  });
});

// ─── parseExpr — comparisons ─────────────────────────────────────────────────

describe("parseExpr — simple comparisons", () => {
  it("parses <a < b>", () => {
    expect(parseExpr("<(i) < (j)>").node).toMatchObject(lt(variable("i"), variable("j")));
  });
  it("parses <a > b>", () => {
    expect(parseExpr("<(i) > (j)>").node).toMatchObject(gt(variable("i"), variable("j")));
  });
  it("parses <a = b>", () => {
    expect(parseExpr("<(i) = (j)>").node).toMatchObject(eq(variable("i"), variable("j")));
  });
  it("parses comparison with list item on left", () => {
    const node = parseExpr("<(item (i) of [list]) > (pivot)>").node;
    expect(node).toMatchObject(gt(itemOfList(variable("i"), "list"), variable("pivot")));
  });
  it("parses comparison with arithmetic on right", () => {
    const node = parseExpr("<(i) < ((j) + (1))>").node;
    expect(node).toMatchObject(lt(variable("i"), add(variable("j"), literal("1"))));
  });
});

describe("parseExpr — <= and >= rewrites", () => {
  it("rewrites <= to not >", () => {
    expect(parseExpr("<(i) <= (j)>").node).toMatchObject(lte(variable("i"), variable("j")));
  });
  it("rewrites >= to not <", () => {
    expect(parseExpr("<(i) >= (j)>").node).toMatchObject(gte(variable("i"), variable("j")));
  });
  it("rewrites list item <= var", () => {
    const node = parseExpr("<(item (j) of [my list]) <= (temp)>").node;
    expect(node.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND.inputs.OPERAND1.opcode).toBe("data_itemoflist");
  });
  it("rewrites list item >= var", () => {
    const node = parseExpr("<(item (i) of [my list]) >= (pivot)>").node;
    expect(node.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.opcode).toBe("operator_lt");
  });
});

// ─── parseExpr — logical operators ───────────────────────────────────────────

describe("parseExpr — logical operators", () => {
  it("parses <A> and <B> (simple)", () => {
    const node = parseExpr("<<(i) < (j)> and <(j) < (k)>>").node;
    expect(node).toMatchObject(and(lt(variable("i"), variable("j")), lt(variable("j"), variable("k"))));
  });
  it("parses <A> or <B> (simple)", () => {
    const node = parseExpr("<<(i) > (j)> or <(j) > (k)>>").node;
    expect(node).toMatchObject(or(gt(variable("i"), variable("j")), gt(variable("j"), variable("k"))));
  });
  it("parses <not <expr>>", () => {
    const node = parseExpr("<not <(i) < (j)>>").node;
    expect(node).toMatchObject(not(lt(variable("i"), variable("j"))));
  });
  it("parses <not <not <expr>>> double negation", () => {
    const node = parseExpr("<not <not <(i) < (j)>>>").node;
    expect(node.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.inputs.OPERAND.opcode).toBe("operator_lt");
  });
  it("parses <A> or <B> where A has item-of-list comparison", () => {
    // <<(item (i) of [my list]) > (pivot)> or <(i) > (r)>>
    const node = parseExpr("<<(item (i) of [my list]) > (pivot)> or <(i) > (r)>>").node;
    expect(node.opcode).toBe("operator_or");
    expect(node.inputs.OPERAND1.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND1.inputs.OPERAND1.opcode).toBe("data_itemoflist");
    expect(node.inputs.OPERAND2).toMatchObject(gt(variable("i"), variable("r")));
  });
  it("parses <A or B> where A uses >= (rewrites to not <)", () => {
    const node = parseExpr("<<(item (i) of [my list]) >= (pivot)> or <(i) > (j)>>").node;
    expect(node.opcode).toBe("operator_or");
    const lhs = node.inputs.OPERAND1;
    expect(lhs.opcode).toBe("operator_not");
    expect(lhs.inputs.OPERAND.opcode).toBe("operator_lt");
  });
  it("parses <A or B> where A uses <= (rewrites to not >)", () => {
    const node = parseExpr("<<(item (j) of [my list]) <= (temp)> or <(i) > (j)>>").node;
    expect(node.opcode).toBe("operator_or");
    const lhs = node.inputs.OPERAND1;
    expect(lhs.opcode).toBe("operator_not");
    expect(lhs.inputs.OPERAND.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND2).toMatchObject(gt(variable("i"), variable("j")));
  });
  it("parses <not <expr>> or <expr> — LLM-style condition", () => {
    // <not <(item (i) of [list]) < (temp)>> or <(i) > (j)>  — outer wraps both
    const node = parseExpr("<<not <(item (i) of [my list]) < (temp)>> or <(i) > (j)>>").node;
    expect(node.opcode).toBe("operator_or");
    expect(node.inputs.OPERAND1.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND2).toMatchObject(gt(variable("i"), variable("j")));
  });
  it("parses <not <A> or <B>> — not takes precedence over the inner A", () => {
    // This form can appear when LLM writes the inner condition already using not
    const node = parseExpr("<<not <(item (j) of [my list]) > (temp)>> or <(j) < (lo)>>").node;
    expect(node.opcode).toBe("operator_or");
    expect(node.inputs.OPERAND1.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND1.inputs.OPERAND.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND2).toMatchObject(lt(variable("j"), variable("lo")));
  });
});

// ─── parsePseudocode — hat blocks ─────────────────────────────────────────────

describe("parsePseudocode — hat blocks", () => {
  it("parses on green-flag:", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  say [hello]");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].hat.opcode).toBe("event_whenflagclicked");
  });
  it("parses when flag clicked: (alias)", () => {
    const { scripts } = parsePseudocode("when flag clicked:\n  say [hi]");
    expect(scripts[0].hat.opcode).toBe("event_whenflagclicked");
  });
  it("parses define block with warp", () => {
    const { scripts } = parsePseudocode("define warp myProc (x) (y)\n  say [hi]");
    expect(scripts[0].hat.opcode).toBe("procedures_definition");
    expect(scripts[0].hat.warp).toBe(true);
    expect(scripts[0].hat.proccode).toBe("myProc (x) (y)");
  });
  it("parses define block without warp", () => {
    expect(parsePseudocode("define myProc (x)\n  say [hi]").scripts[0].hat.warp).toBe(false);
  });
  it("warp flag is false on non-define hats", () => {
    expect(parsePseudocode("on green-flag:\n  say [hi]").scripts[0].hat.warp).toBe(false);
  });
  it("parses when I receive [message]", () => {
    const { scripts } = parsePseudocode("when I receive [go]:\n  say [hi]");
    expect(scripts[0].hat.opcode).toBe("event_whenbroadcastreceived");
  });
  it("ignores 'end' written after hat block (LLM mistake)", () => {
    // LLMs sometimes write 'end' after a hat block — it should not create a new script
    const { scripts } = parsePseudocode("on green-flag:\n  say [hi]\nend");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].body).toHaveLength(1);
  });
});

// ─── parsePseudocode — statements ────────────────────────────────────────────

describe("parsePseudocode — statements", () => {
  it("parses set variable to literal", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  set [i] to (1)");
    const stmt = scripts[0].body[0];
    expect(stmt.opcode).toBe("data_setvariableto");
    expect(stmt.fields.VARIABLE[0]).toBe("i");
    expect(stmt.inputs.VALUE).toMatchObject(literal("1"));
  });
  it("parses set variable to arithmetic expression", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  set [j] to ((hi) - (1))");
    const stmt = scripts[0].body[0];
    expect(stmt.inputs.VALUE).toMatchObject(sub(variable("hi"), literal("1")));
  });
  it("parses set variable to item of list", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  set [temp] to (item (i) of [my list])");
    const stmt = scripts[0].body[0];
    expect(stmt.inputs.VALUE.opcode).toBe("data_itemoflist");
  });
  it("parses change variable", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  change [i] by (1)");
    expect(scripts[0].body[0].opcode).toBe("data_changevariableby");
  });
  it("parses replace item of list with variable", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  replace item (i) of [my list] with (temp)");
    const stmt = scripts[0].body[0];
    expect(stmt.opcode).toBe("data_replaceitemoflist");
    expect(stmt.fields.LIST[0]).toBe("my list");
    expect(stmt.inputs.INDEX).toMatchObject(variable("i"));
    expect(stmt.inputs.ITEM).toMatchObject(variable("temp"));
  });
  it("parses replace item of list with list item", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  replace item (i) of [my list] with (item (j) of [my list])");
    expect(scripts[0].body[0].inputs.ITEM.opcode).toBe("data_itemoflist");
  });
  it("parses say [text]", () => {
    expect(parsePseudocode("on green-flag:\n  say [Hello!]").scripts[0].body[0].opcode).toBe("looks_say");
  });
  it("parses wait (N) secs", () => {
    expect(parsePseudocode("on green-flag:\n  wait (1) secs").scripts[0].body[0].opcode).toBe("control_wait");
  });
  it("parses stop this script (from break alias)", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  break");
    expect(scripts[0].body[0].opcode).toBe("control_stop");
  });
  it("parses stop [this script]", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  stop [this script]");
    expect(scripts[0].body[0].opcode).toBe("control_stop");
  });
  it("parses stop [all]", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  stop [all]");
    expect(scripts[0].body[0].opcode).toBe("control_stop");
  });
  it("parses add [item] to [list]", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  add [hello] to [my list]");
    expect(scripts[0].body[0].opcode).toBe("data_addtolist");
  });
  it("parses delete all of [list]", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  delete all of [my list]");
    expect(scripts[0].body[0].opcode).toBe("data_deletealloflist");
  });
  it("parses procedures_call with literal args", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  quicksort (1) (10)");
    const stmt = scripts[0].body[0];
    expect(stmt.opcode).toBe("procedures_call");
    expect(stmt.proccode).toContain("quicksort");
  });
  it("parses procedures_call with arithmetic args", () => {
    // quicksort ((i) + (1)) (hi)  — common recursive call pattern
    const { scripts } = parsePseudocode("on green-flag:\n  quicksort ((i) + (1)) (hi)");
    expect(scripts[0].body[0].opcode).toBe("procedures_call");
  });
  it("parses procedures_call with (length of [list]) arg", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  quicksort (1) ((length of [my list]))");
    expect(scripts[0].body[0].opcode).toBe("procedures_call");
  });
});

// ─── parsePseudocode — c-blocks ───────────────────────────────────────────────

describe("parsePseudocode — c-blocks", () => {
  it("parses if/then/end", () => {
    const code = "on green-flag:\n  if <(i) < (j)> then:\n    say [yes]\n  end";
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.type).toBe("c-block");
    expect(cb.opcode).toBe("control_if");
    expect(cb.inputs.CONDITION.opcode).toBe("operator_lt");
    expect(cb.body).toHaveLength(1);
    expect(cb.elseBody).toBeNull();
  });
  it("parses if/else/end", () => {
    const code = "on green-flag:\n  if <(i) < (j)> then:\n    say [yes]\n  else:\n    say [no]\n  end";
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.opcode).toBe("control_if_else");
    expect(cb.body).toHaveLength(1);
    expect(cb.elseBody).toHaveLength(1);
  });
  it("parses repeat N times", () => {
    const code = "on green-flag:\n  repeat (10) times:\n    change [i] by (1)\n  end";
    expect(parsePseudocode(code).scripts[0].body[0].opcode).toBe("control_repeat");
  });
  it("parses forever loop", () => {
    const code = "on green-flag:\n  forever:\n    say [hi]\n  end";
    expect(parsePseudocode(code).scripts[0].body[0].opcode).toBe("control_forever");
  });
  it("parses repeat until", () => {
    const code = "on green-flag:\n  repeat until <(i) > (j)>:\n    change [i] by (1)\n  end";
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.opcode).toBe("control_repeat_until");
    expect(cb.inputs.CONDITION).toMatchObject(gt(variable("i"), variable("j")));
  });
  it("parses repeat until with complex condition (and/or)", () => {
    const code = [
      "on green-flag:",
      "  repeat until <<(item (i) of [list]) >= (pivot)> or <(i) > (j)>>:",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.inputs.CONDITION.opcode).toBe("operator_or");
    // >= rewrites to not(lt)
    expect(cb.inputs.CONDITION.inputs.OPERAND1.opcode).toBe("operator_not");
    expect(cb.inputs.CONDITION.inputs.OPERAND1.inputs.OPERAND.opcode).toBe("operator_lt");
  });
  it("parses repeat until with not-<comparison> condition", () => {
    const code = [
      "on green-flag:",
      "  repeat until <not <(item (i) of [list]) < (temp)>>:",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.inputs.CONDITION.opcode).toBe("operator_not");
    expect(cb.inputs.CONDITION.inputs.OPERAND.opcode).toBe("operator_lt");
  });
  it("parses if with <= condition (rewrites to not >)", () => {
    const code = "on green-flag:\n  if <(i) <= (j)> then:\n    say [yes]\n  end";
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.inputs.CONDITION.opcode).toBe("operator_not");
    expect(cb.inputs.CONDITION.inputs.OPERAND.opcode).toBe("operator_gt");
  });
  it("parses nested c-blocks", () => {
    const code = [
      "on green-flag:",
      "  repeat until <(i) > (j)>:",
      "    if <(i) < (j)> then:",
      "      change [i] by (1)",
      "    end",
      "  end",
    ].join("\n");
    const outer = parsePseudocode(code).scripts[0].body[0];
    expect(outer.opcode).toBe("control_repeat_until");
    expect(outer.body[0].opcode).toBe("control_if");
    expect(outer.body[0].body).toHaveLength(1);
  });
  it("handles repeat until with comment on condition line", () => {
    const code = [
      "on green-flag:",
      "  repeat until <(i) > (j)>:  // outer loop",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    const cb = parsePseudocode(code).scripts[0].body[0];
    expect(cb.opcode).toBe("control_repeat_until");
    expect(cb.inputs.CONDITION).toMatchObject(gt(variable("i"), variable("j")));
  });
});

// ─── parsePseudocode — comment and meta-line handling ─────────────────────────

describe("parsePseudocode — comments and meta lines", () => {
  it("strips // comments from statement lines", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  change [i] by (1)  // increment i");
    expect(scripts[0].body).toHaveLength(1);
    expect(scripts[0].body[0].opcode).toBe("data_changevariableby");
  });
  it("skips pure comment lines", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  // this is a comment\n  say [hi]");
    expect(scripts[0].body).toHaveLength(1);
  });
  it("skips markdown heading lines", () => {
    const { scripts } = parsePseudocode("# Setup\non green-flag:\n  say [hi]");
    expect(scripts).toHaveLength(1);
  });
  it("skips markdown bold lines", () => {
    const { scripts } = parsePseudocode("**Note:** Do something\non green-flag:\n  say [hi]");
    expect(scripts).toHaveLength(1);
  });
  it("skips --- separator lines", () => {
    const { scripts } = parsePseudocode("---\non green-flag:\n  say [hi]");
    expect(scripts).toHaveLength(1);
  });
  it("skips backtick fence lines (``` code blocks from LLM)", () => {
    const code = "```\non green-flag:\n  say [hi]\n```";
    const { scripts } = parsePseudocode(code);
    expect(scripts).toHaveLength(1);
  });
  it("parses sprite header line and scopes following script", () => {
    const code = "Sprite1 | on green-flag: | [→ abc123]\non green-flag:\n  say [hi]";
    const { scripts } = parsePseudocode(code);
    expect(scripts).toHaveLength(1);
  });
});

// ─── parsePseudocode — multiple scripts ───────────────────────────────────────

describe("parsePseudocode — multiple scripts", () => {
  it("parses define + on green-flag as two scripts", () => {
    const code = ["define warp sort (n)", "  change [n] by (1)", "", "on green-flag:", "  sort (10)"].join("\n");
    const { scripts } = parsePseudocode(code);
    expect(scripts).toHaveLength(2);
    expect(scripts[0].hat.opcode).toBe("procedures_definition");
    expect(scripts[1].hat.opcode).toBe("event_whenflagclicked");
  });
  it("produces no warnings for valid input", () => {
    const { warnings } = parsePseudocode("on green-flag:\n  say [hi]");
    expect(warnings).toHaveLength(0);
  });
});

// ─── parsePseudocode — no unknown nodes in well-formed input ──────────────────

describe("parsePseudocode — no unknown_ opcodes in well-formed input", () => {
  it("no unknowns in simple if/repeat", () => {
    const code = [
      "on green-flag:",
      "  set [i] to (1)",
      "  repeat until <(i) > (10)>",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    const { scripts } = parsePseudocode(code);
    noUnknowns(scripts);
  });

  it("no unknowns in or-condition with list comparison", () => {
    const code = [
      "on green-flag:",
      "  repeat until <<(item (i) of [list]) > (pivot)> or <(i) > (j)>>",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    noUnknowns(parsePseudocode(code).scripts);
  });

  it("no unknowns in not<condition> repeat", () => {
    const code = [
      "on green-flag:",
      "  repeat until <not <(item (i) of [list]) < (pivot)>>",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    noUnknowns(parsePseudocode(code).scripts);
  });

  it("no unknowns in >= condition inside or", () => {
    const code = [
      "on green-flag:",
      "  repeat until <<(item (i) of [list]) >= (pivot)> or <(i) > (j)>>",
      "    change [i] by (1)",
      "  end",
    ].join("\n");
    noUnknowns(parsePseudocode(code).scripts);
  });

  it("no unknowns in <= condition inside or", () => {
    const code = [
      "on green-flag:",
      "  repeat until <<(item (j) of [list]) <= (pivot)> or <(j) < (lo)>>",
      "    change [j] by (-1)",
      "  end",
    ].join("\n");
    noUnknowns(parsePseudocode(code).scripts);
  });
});

// ─── parsePseudocode — full quicksort script ─────────────────────────────────

describe("parsePseudocode — quicksort", () => {
  const QUICKSORT = `
define warp quicksort (lo) (hi)
  if <(lo) < (hi)> then:
    set [pivot] to (item (hi) of [my list])
    set [i] to (lo)
    set [j] to ((hi) - (1))
    repeat until <(i) > (j)>
      repeat until <<(item (i) of [my list]) >= (pivot)> or <(i) > (j)>>
        change [i] by (1)
      end
      repeat until <<(item (j) of [my list]) <= (pivot)> or <(j) < (lo)>>
        change [j] by (-1)
      end
      if <(i) <= (j)> then:
        set [temp] to (item (i) of [my list])
        replace item (i) of [my list] with (item (j) of [my list])
        replace item (j) of [my list] with (temp)
        change [i] by (1)
        change [j] by (-1)
      end
    end
    quicksort (lo) (j)
    quicksort (i) (hi)
  end
`.trim();

  it("produces one script, no warnings", () => {
    const { scripts, warnings } = parsePseudocode(QUICKSORT);
    expect(warnings).toHaveLength(0);
    expect(scripts).toHaveLength(1);
  });
  it("hat is procedures_definition with warp", () => {
    const { scripts } = parsePseudocode(QUICKSORT);
    expect(scripts[0].hat.opcode).toBe("procedures_definition");
    expect(scripts[0].hat.warp).toBe(true);
    expect(scripts[0].hat.proccode).toBe("quicksort (lo) (hi)");
  });
  it("outer if condition is operator_lt", () => {
    const { scripts } = parsePseudocode(QUICKSORT);
    expect(scripts[0].body[0].inputs.CONDITION.opcode).toBe("operator_lt");
  });
  it("inner repeat-until conditions use >= and <= (rewritten to not)", () => {
    const { scripts } = parsePseudocode(QUICKSORT);
    const outerRepeat = scripts[0].body[0].body[3];
    expect(outerRepeat.opcode).toBe("control_repeat_until");
    const innerRepeat1 = outerRepeat.body[0];
    const innerRepeat2 = outerRepeat.body[1];
    // >= → not(lt)
    expect(innerRepeat1.inputs.CONDITION.opcode).toBe("operator_or");
    const lhs1 = innerRepeat1.inputs.CONDITION.inputs.OPERAND1;
    expect(lhs1.opcode).toBe("operator_not");
    expect(lhs1.inputs.OPERAND.opcode).toBe("operator_lt");
    // <= → not(gt)
    expect(innerRepeat2.inputs.CONDITION.opcode).toBe("operator_or");
    const lhs2 = innerRepeat2.inputs.CONDITION.inputs.OPERAND1;
    expect(lhs2.opcode).toBe("operator_not");
    expect(lhs2.inputs.OPERAND.opcode).toBe("operator_gt");
  });
  it("if <i <= j> rewrites to not >", () => {
    const { scripts } = parsePseudocode(QUICKSORT);
    const outerRepeat = scripts[0].body[0].body[3];
    const swapIf = outerRepeat.body[2];
    expect(swapIf.inputs.CONDITION.opcode).toBe("operator_not");
    expect(swapIf.inputs.CONDITION.inputs.OPERAND.opcode).toBe("operator_gt");
  });
  it("recursive calls are procedures_call", () => {
    const { scripts } = parsePseudocode(QUICKSORT);
    const body = scripts[0].body[0].body;
    const call1 = body[body.length - 2];
    const call2 = body[body.length - 1];
    expect(call1.opcode).toBe("procedures_call");
    expect(call2.opcode).toBe("procedures_call");
  });
  it("produces no unknown_ opcodes anywhere", () => {
    noUnknowns(parsePseudocode(QUICKSORT).scripts);
  });
});

// ─── LLM quirk: extra opening paren around operand ───────────────────────────

describe("parseExpr — LLM extra paren around operand", () => {
  it("parses ((item (i) of [list]) < (temp) — double-( on left of comparison", () => {
    // LLM sometimes writes ((item (i) of [list]) instead of (item (i) of [list])
    const node = parseExpr("<((item (i) of [my list]) < (temp)>").node;
    expect(node.opcode).toBe("operator_lt");
    expect(node.inputs.OPERAND1.opcode).toBe("data_itemoflist");
    expect(node.inputs.OPERAND2).toMatchObject(variable("temp"));
  });
  it("parses <not <((item (i) of [list]) < (temp)>> — extra ( inside not", () => {
    const node = parseExpr("<not <((item (i) of [my list]) < (temp)>>").node;
    expect(node.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.opcode).toBe("operator_lt");
    expect(node.inputs.OPERAND.inputs.OPERAND1.opcode).toBe("data_itemoflist");
    expect(node.inputs.OPERAND.inputs.OPERAND2).toMatchObject(variable("temp"));
  });
  it("parses <not <((item (j) of [list]) > (temp)>> — extra ( inside not, > operator", () => {
    const node = parseExpr("<not <((item (j) of [my list]) > (temp)>>").node;
    expect(node.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND.inputs.OPERAND1.opcode).toBe("data_itemoflist");
  });
  it("parses <not <...> or <...>> with extra ( inside not", () => {
    const node = parseExpr("<not <((item (i) of [my list]) < (temp)>> or <(i) > (right)>>").node;
    expect(node.opcode).toBe("operator_or");
    expect(node.inputs.OPERAND1.opcode).toBe("operator_not");
    expect(node.inputs.OPERAND1.inputs.OPERAND.opcode).toBe("operator_lt");
    expect(node.inputs.OPERAND1.inputs.OPERAND.inputs.OPERAND1.opcode).toBe("data_itemoflist");
    expect(node.inputs.OPERAND2).toMatchObject(gt(variable("i"), variable("right")));
  });
});

// ─── LLM quirk: Unicode comparison characters ─────────────────────────────────

describe("parseExpr — Unicode comparison characters from LLM", () => {
  it("parses <(i) ≤ (j)> — Unicode ≤ as <=", () => {
    const node = parseExpr("<(i) ≤ (j)>").node;
    expect(node.opcode).toBe("operator_not"); // <= → not >
    expect(node.inputs.OPERAND.opcode).toBe("operator_gt");
    expect(node.inputs.OPERAND.inputs.OPERAND1).toMatchObject(variable("i"));
    expect(node.inputs.OPERAND.inputs.OPERAND2).toMatchObject(variable("j"));
  });
  it("parses <(i) ≥ (j)> — Unicode ≥ as >=", () => {
    const node = parseExpr("<(i) ≥ (j)>").node;
    expect(node.opcode).toBe("operator_not"); // >= → not <
    expect(node.inputs.OPERAND.opcode).toBe("operator_lt");
  });
  it("normalizes ≤ in if condition", () => {
    const { scripts } = parsePseudocode("on green-flag:\n  if <(i) ≤ (j)> then:\n    say [yes]\n  end");
    const cond = scripts[0].body[0].inputs.CONDITION;
    expect(cond.opcode).toBe("operator_not");
    expect(cond.inputs.OPERAND.opcode).toBe("operator_gt");
  });
});
