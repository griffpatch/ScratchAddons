/**
 * pseudocode-parser.js
 *
 * Parses the pseudocode text produced by projectToPseudocode() back into an AST.
 *
 * Exports:
 *   parsePseudocode(text) → { scripts: Script[], warnings: Warning[] }
 *
 * Each Script:
 *   { type:"script", spriteName:string, isStage:bool, hat:Node|null, body:Node[] }
 *
 * Node types: "hat" | "statement" | "c-block" | "unknown"
 * See PSEUDOCODE-CONVERTER.md for the full AST shape.
 */

// ─── Expression parser ────────────────────────────────────────────────────────
//
// Expressions appear inside (...), [...], or <...> delimiters.
// We produce a simple value-tree:
//   { kind: "literal",   value: string }
//   { kind: "reporter",  opcode: string, inputs: {}, fields: {} }
//   { kind: "boolean",   opcode: string, inputs: {}, fields: {} }
//   { kind: "unknown",   raw: string }

/**
 * Parse the outermost expression from a string, returning { node, rest }.
 * `rest` is whatever comes after the parsed expression.
 */
export function parseExpr(text) {
  const s = (text == null ? "" : String(text)).trimStart();
  if (!s) return { node: null, rest: "" };

  if (s.startsWith("(")) return parseParen(s);
  if (s.startsWith("[")) return parseBracket(s);
  if (s.startsWith("<")) return parseAngle(s);

  // Bare number literal (e.g. 10, -3.5)
  const numMatch = s.match(/^-?\d+(\.\d+)?/);
  if (numMatch) return { node: { kind: "literal", value: numMatch[0] }, rest: s.slice(numMatch[0].length) };

  // "length of [list]" bare — appears as an operand after splitBinaryOp strips outer parens
  // Allow optional " :: type" annotation after the closing ]
  const bareLenMatch = s.match(/^length of\s+\[(.+?)\](?:\s*::\s*\w[\w\s]*)?(.*)/i);
  if (bareLenMatch) {
    return {
      node: {
        kind: "reporter",
        opcode: "data_lengthoflist",
        inputs: {},
        fields: { LIST: [stripV(bareLenMatch[1]), null] },
      },
      rest: bareLenMatch[2],
    };
  }

  // "item N of [list]" bare
  const bareItemMatch = s.match(/^item\s+(.+?)\s+of\s+\[(.+?)\](?:\s*::\s*\w[\w\s]*)?(.*)/i);
  if (bareItemMatch) {
    return {
      node: {
        kind: "reporter",
        opcode: "data_itemoflist",
        inputs: { INDEX: parseExpr(bareItemMatch[1]).node },
        fields: { LIST: [stripV(bareItemMatch[2]), null] },
      },
      rest: bareItemMatch[3],
    };
  }

  // Bare word — could be a variable name (e.g. left side of comparison) or a string literal.
  // Heuristic: if it looks like an identifier (letters/digits/underscore/space-separated words)
  // treat it as a variable reporter so it resolves correctly.
  const wordMatch = s.match(/^[^\s,)>\]]+/);
  if (wordMatch) {
    const word = wordMatch[0];
    // Pure identifiers (no operators/brackets) are likely variable names
    if (/^[A-Za-z_]\w*$/.test(word)) {
      return {
        node: { kind: "reporter", opcode: "data_variable", inputs: {}, fields: { VARIABLE: [word, null] } },
        rest: s.slice(word.length),
      };
    }
    return { node: { kind: "literal", value: word }, rest: s.slice(word.length) };
  }

  return { node: { kind: "unknown", raw: s }, rest: "" };
}

/** Find the matching closer for an opener at index 0. Returns the whole delimited string. */
function extractBalanced(s, open, close) {
  if (s[0] !== open) return null;

  // For angle brackets <>, the > character is ambiguous: it also serves as a
  // comparison operator inside a boolean like <expr > expr>. Strategy: collect
  // ALL candidate > positions (not inside () or []), then try from LAST to FIRST
  // returning the first that produces balanced content inside.
  if (open === "<") {
    const candidates = [];
    let pd = 0,
      sd = 0;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") {
        pd++;
        continue;
      }
      if (ch === ")") {
        if (pd > 0) pd--;
        continue;
      }
      if (ch === "[") {
        sd++;
        continue;
      }
      if (ch === "]") {
        if (sd > 0) sd--;
        continue;
      }
      // Allow > as a candidate even when pd > 0: in Scratch notation > cannot close
      // parens, so a > at sd=0 is always a potential angle-bracket closer.
      // Skip >= (comparison operator — not a bracket closer).
      if (ch === ">" && sd === 0 && s[i + 1] !== "=") candidates.push(i);
    }
    // Try from last to first — the outermost (rightmost) valid > is the true closer.
    for (let ci = candidates.length - 1; ci >= 0; ci--) {
      const pos = candidates[ci];
      const inner = s.slice(1, pos);
      // inner must have balanced <>, (), []
      let d = 0,
        pp = 0,
        ss = 0,
        valid = true;
      for (let j = 0; j < inner.length; j++) {
        const c = inner[j];
        if (c === "(") {
          pp++;
          continue;
        }
        if (c === ")") {
          if (pp > 0) pp--;
          continue;
        }
        if (c === "[") {
          ss++;
          continue;
        }
        if (c === "]") {
          if (ss > 0) ss--;
          continue;
        }
        if (ss === 0) {
          if (c === "<" && pp === 0) {
            // Comparison < is only preceded by ) or ] (closing a paren/bracket expression)
            // or followed by = (i.e. <=). Word chars like 'd' in 'and' must NOT trigger
            // this — 'and <' is a boolean opener, not a comparison.
            let k = j - 1;
            while (k >= 0 && inner[k] === " ") k--;
            if (!/[)\]]/.test(k >= 0 ? inner[k] : "") && inner[j + 1] !== "=") d++;
          } else if (c === ">" && d > 0) {
            // Comparison > is followed by ( or [ or = (i.e. >=) — don't count as angle closer.
            let k = j + 1;
            while (k < inner.length && inner[k] === " ") k++;
            if (!/[(\[]/.test(k < inner.length ? inner[k] : "") && inner[j + 1] !== "=") {
              pp = 0;
              d--;
            }
          }
        }
      }
      if (valid && d === 0 && pp === 0 && ss === 0) return s.slice(0, pos + 1);
    }
    // No perfectly balanced closer found (e.g. LLM wrote malformed/unclosed parens inside).
    // Fall back to the last > candidate to capture as much content as possible.
    if (candidates.length > 0) return s.slice(0, candidates[candidates.length - 1] + 1);
    return null;
  }

  // For () and [] — simple depth tracking.
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    } // escape
    if (s[i] === open) depth++;
    if (s[i] === close) {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
    i++;
  }
  return null; // unclosed
}

function parseParen(s) {
  const full = extractBalanced(s, "(", ")");
  if (!full) {
    // Unbalanced parens — LLM sometimes writes "((item (i)..." with an extra opening "(".
    // Strip one extra "(" and retry once.
    if (s.startsWith("((")) return parseParen(s.slice(1));
    return { node: { kind: "unknown", raw: s }, rest: "" };
  }
  const inner = full.slice(1, -1);
  const rest = s.slice(full.length);
  // Could be a reporter like (x position), (y position), (size), (variable name), operator…
  const node = parseParenInner(inner);
  return { node, rest };
}

function parseParenInner(inner) {
  // Bare number — e.g. (1), (3.14), (-5). Must check before splitBinaryOp.
  if (/^-?\d+(\.\d+)?$/.test(inner.trim())) return { kind: "literal", value: inner.trim() };

  // If inner is itself entirely wrapped in parens (e.g. LLM double-wrapped like
  // "((length of [x]) - (i))"), strip one level and recurse.
  if (inner.trimStart().startsWith("(")) {
    const bal = extractBalanced(inner.trimStart(), "(", ")");
    if (bal && bal.length === inner.trim().length) {
      return parseParenInner(bal.slice(1, -1));
    }
  }

  // Binary operators: NUM OP NUM inside parens
  // e.g. "(a + b)", "(a - b)", "(a * b)", "(a / b)", "(a mod b)"
  // We try to split on the operator, being careful about nested parens.
  const opMatch = splitBinaryOp(inner);
  if (opMatch) {
    const { left, op, right } = opMatch;
    const opcode = ARITH_OPS[op];
    if (opcode) {
      return {
        kind: "reporter",
        opcode,
        inputs: { NUM1: parseExpr(left).node, NUM2: parseExpr(right).node },
        fields: {},
      };
    }
  }
  // join, letter of, length of — check keywords
  if (/^join\s/i.test(inner)) {
    const args = splitArgs(inner.replace(/^join\s+/i, ""), 2);
    return {
      kind: "reporter",
      opcode: "operator_join",
      inputs: { STRING1: parseExpr(args[0] ?? "").node, STRING2: parseExpr(args[1] ?? "").node },
      fields: {},
    };
  }
  if (/^letter\s/i.test(inner)) {
    // letter N of STR
    const m = inner.match(/^letter\s+(.+?)\s+of\s+(.+)$/i);
    if (m)
      return {
        kind: "reporter",
        opcode: "operator_letter_of",
        inputs: { LETTER: parseExpr(m[1]).node, STRING: parseExpr(m[2]).node },
        fields: {},
      };
  }
  // "length of [list]" must come before the generic operator_length check
  // Allow optional " :: type" annotation after the closing ]
  const listLenParenMatch = inner.match(/^length of\s+\[(.+?)\](?:\s*::.*)?$/i);
  if (listLenParenMatch) {
    return {
      kind: "reporter",
      opcode: "data_lengthoflist",
      inputs: {},
      fields: { LIST: [stripV(listLenParenMatch[1]), null] },
    };
  }
  if (/^length of\s/i.test(inner)) {
    return {
      kind: "reporter",
      opcode: "operator_length",
      inputs: { STRING: parseExpr(inner.replace(/^length of\s+/i, "")).node },
      fields: {},
    };
  }
  if (/^round\s/i.test(inner)) {
    return {
      kind: "reporter",
      opcode: "operator_round",
      inputs: { NUM: parseExpr(inner.replace(/^round\s+/i, "")).node },
      fields: {},
    };
  }
  const mathMatch = inner.match(/^(abs|floor|ceiling|sqrt|sin|cos|tan|asin|acos|atan|ln|log|e\^|10\^)\s+of\s+(.+)$/i);
  if (mathMatch) {
    return {
      kind: "reporter",
      opcode: "operator_mathop",
      inputs: { NUM: parseExpr(mathMatch[2]).node },
      fields: { OPERATOR: [mathMatch[1], null] },
    };
  }
  if (/^(?:pick\s+)?random\s/i.test(inner)) {
    const m = inner.match(/^(?:pick\s+)?random\s+(.+?)\s+to\s+(.+)$/i);
    if (m)
      return {
        kind: "reporter",
        opcode: "operator_random",
        inputs: { FROM: parseExpr(m[1]).node, TO: parseExpr(m[2]).node },
        fields: {},
      };
  }
  // Known zero-arg reporters
  const REPORTERS = {
    "x position": "motion_xposition",
    "y position": "motion_yposition",
    direction: "motion_direction",
    size: "looks_size",
    "costume number": "looks_costumenumbername",
    "costume name": "looks_costumenumbername",
    "backdrop number": "looks_backdropnumbername",
    "backdrop name": "looks_backdropnumbername",
    volume: "sound_volume",
    answer: "sensing_answer",
    timer: "sensing_timer",
    loudness: "sensing_loudness",
    "mouse x": "sensing_mousex",
    "mouse y": "sensing_mousey",
    username: "sensing_username",
    "days since 2000": "sensing_dayssince2000",
  };
  const lower = inner.toLowerCase().trim();
  if (REPORTERS[lower]) {
    const opcode = REPORTERS[lower];
    const fields = {};
    if (opcode === "looks_costumenumbername") fields.NUMBER_NAME = [lower.includes("name") ? "name" : "number", null];
    if (opcode === "looks_backdropnumbername") fields.NUMBER_NAME = [lower.includes("name") ? "name" : "number", null];
    return { kind: "reporter", opcode, inputs: {}, fields };
  }
  // "item N of [list]" or "item # of ITEM in [list]"
  // Allow optional " :: type" annotation after the closing ]
  const itemMatch = inner.match(/^item\s+(.+?)\s+of\s+\[(.+?)\](?:\s*::.*)?$/i);
  if (itemMatch) {
    return {
      kind: "reporter",
      opcode: "data_itemoflist",
      inputs: { INDEX: parseExpr(itemMatch[1]).node },
      fields: { LIST: [stripV(itemMatch[2]), null] },
    };
  }
  // "length of [list]"
  const listLenMatch = inner.match(/^length of\s+\[(.+?)\](?:\s*::.*)?$/i);
  if (listLenMatch) {
    return {
      kind: "reporter",
      opcode: "data_lengthoflist",
      inputs: {},
      fields: { LIST: [stripV(listLenMatch[1]), null] },
    };
  }
  // "current [WHAT]"
  const currentMatch = inner.match(/^current\s+\[(.+)\]$/i);
  if (currentMatch) {
    return {
      kind: "reporter",
      opcode: "sensing_current",
      inputs: {},
      fields: { CURRENTMENU: [currentMatch[1].toUpperCase(), null] },
    };
  }
  // "WHAT of [sprite]" — sensing_of
  const ofMatch = inner.match(/^(.+?)\s+of\s+\[(.+)\]$/i);
  if (ofMatch) {
    return {
      kind: "reporter",
      opcode: "sensing_of",
      inputs: {},
      fields: { PROPERTY: [ofMatch[1], null], OBJECT: [ofMatch[2], null] },
    };
  }
  // "distance to [thing]" or "distance to (thing)"
  const distMatch = inner.match(/^distance to\s+(.+)$/i);
  if (distMatch) {
    return {
      kind: "reporter",
      opcode: "sensing_distanceto",
      inputs: {},
      fields: { DISTANCETOMENU: [distMatch[1].replace(/^\[|\]$/g, ""), null] },
    };
  }
  // Comparison operators inside parens — LLMs sometimes write (a = b) instead of <a = b>.
  // This handles cases like `<not (swapped = 1)>` where the inner (swapped = 1) is a boolean.
  const cmpMatch = splitCompareOp(inner);
  if (cmpMatch && cmpMatch.left && cmpMatch.right) {
    const CMP_OPS = { "=": "operator_equals", "<": "operator_lt", ">": "operator_gt" };
    const cmpOpcode = CMP_OPS[cmpMatch.op];
    if (cmpOpcode) {
      return {
        kind: "boolean",
        opcode: cmpOpcode,
        inputs: { OPERAND1: parseExpr(cmpMatch.left).node, OPERAND2: parseExpr(cmpMatch.right).node },
        fields: {},
      };
    }
    // Scratch has no <= or >= — rewrite: a<=b → not<a>b>, a>=b → not<a<b>
    if (cmpMatch.op === "<=") {
      return {
        kind: "boolean",
        opcode: "operator_not",
        fields: {},
        inputs: {
          OPERAND: {
            kind: "boolean",
            opcode: "operator_gt",
            fields: {},
            inputs: { OPERAND1: parseExpr(cmpMatch.left).node, OPERAND2: parseExpr(cmpMatch.right).node },
          },
        },
      };
    }
    if (cmpMatch.op === ">=") {
      return {
        kind: "boolean",
        opcode: "operator_not",
        fields: {},
        inputs: {
          OPERAND: {
            kind: "boolean",
            opcode: "operator_lt",
            fields: {},
            inputs: { OPERAND1: parseExpr(cmpMatch.left).node, OPERAND2: parseExpr(cmpMatch.right).node },
          },
        },
      };
    }
  }

  // Variable reporter — bare name in parens (handle both "varname" and "[varname v]" forms)
  // Treat "true" / "false" as string literals (common in AI-generated pseudocode)
  if (inner === "true" || inner === "false") return { kind: "literal", value: inner };
  let varName = unescapeVar(inner);
  if (varName.startsWith("[") && varName.endsWith("]")) varName = varName.slice(1, -1);
  varName = stripV(varName);
  return { kind: "reporter", opcode: "data_variable", inputs: {}, fields: { VARIABLE: [varName, null] } };
}

function parseBracket(s) {
  const full = extractBalanced(s, "[", "]");
  if (!full) return { node: { kind: "unknown", raw: s }, rest: "" };
  // Strip Scratch's " v" dropdown marker and ":: type" block-type annotations from inside
  const inner = stripV(full.slice(1, -1))
    .replace(/\s*::.*$/, "")
    .trim();
  // Consume any trailing ":: type" annotation appearing after the ]
  const rest = s.slice(full.length).replace(/^\s*::\s*\w[\w\s]*/, "");
  return { node: { kind: "literal", value: inner }, rest };
}

function parseAngle(s) {
  const full = extractBalanced(s, "<", ">");
  if (!full) return { node: { kind: "unknown", raw: s }, rest: "" };
  const inner = full.slice(1, -1).trim();
  const rest = s.slice(full.length);
  const node = parseAngleInner(inner);
  return { node, rest };
}

function parseAngleInner(inner) {
  // Normalize inner to handle common LLM mistakes before any other parsing:
  //
  // 1. Extra leading "(" — LLM sometimes writes "((item (i) of [list]) < (temp)"
  //    with an unmatched opening paren. Detect by counting ( vs ) and strip one.
  //
  // 2. Spurious trailing ">" — when extractBalanced falls back to its "last candidate"
  //    heuristic on a string with a double ">>" (e.g. "<<A>> or <B>>"), the inner
  //    content can acquire a trailing ">". After stripping the extra "(", detect this
  //    via a simple net angle-bracket count and strip it too.
  {
    let parenOpens = 0,
      parenCloses = 0;
    for (const ch of inner) {
      if (ch === "(") parenOpens++;
      else if (ch === ")") parenCloses++;
    }
    if (parenOpens > parenCloses && inner.startsWith("(")) {
      inner = inner.slice(1);
      if (inner.endsWith(">")) {
        // Use a lookback-aware angle count so comparison "<" (preceded by ")" or "]")
        // is not counted as a boolean bracket opener.
        let angleNet = 0;
        let prevSig = "";
        for (const ch of inner) {
          if (ch === "<") {
            if (!/[)\]a-zA-Z0-9_]/.test(prevSig)) angleNet++;
          } else if (ch === ">") {
            angleNet--;
          }
          if (ch !== " ") prevSig = ch;
        }
        if (angleNet < 0) inner = inner.slice(0, -1);
      }
    }
  }

  // Comparison operators: expr OP expr.
  // If the entire inner is wrapped in outer parens (e.g. "((j) > (0))"), strip one
  // level so splitCompareOp can find the operator at the top level.
  const unwrapped = (() => {
    if (!inner.startsWith("(")) return inner;
    const bal = extractBalanced(inner, "(", ")");
    return bal && bal.length === inner.trim().length ? bal.slice(1, -1) : inner;
  })();

  // If inner starts with "<", it means the trailing ">" was consumed by the outer angle
  // bracket closer (e.g. "and <expr > val" loses its closing ">"). Re-add it and re-parse.
  // BUT: only do this recovery if splitLogical can't find an and/or — because an expression
  // like "<A> and <B>" has inner starting with "<" for a legitimate reason, and the recovery
  // path would misparse it.
  // and / or — check BEFORE recovery so "<A> and <B>" is handled correctly.
  // splitLogical returns parts that may already be wrapped in <>, so only add
  // wrappers if the part isn't already a complete <...> expression.
  const wrapAngle = (s) => (s.startsWith("<") && s.endsWith(">") ? parseAngle(s).node : parseAngle("<" + s + ">").node);

  const andMatch = splitLogical(inner, " and ");
  if (andMatch)
    return {
      kind: "boolean",
      opcode: "operator_and",
      inputs: { OPERAND1: wrapAngle(andMatch.left), OPERAND2: wrapAngle(andMatch.right) },
      fields: {},
    };

  const orMatch = splitLogical(inner, " or ");
  if (orMatch)
    return {
      kind: "boolean",
      opcode: "operator_or",
      inputs: { OPERAND1: wrapAngle(orMatch.left), OPERAND2: wrapAngle(orMatch.right) },
      fields: {},
    };

  if (inner.startsWith("<")) {
    const recovered = parseAngle(inner + ">");
    if (recovered.node && recovered.node.opcode !== "unknown_boolean") return recovered.node;
  }

  const cmpMatch = splitCompareOp(unwrapped);
  if (cmpMatch) {
    const { left, op, right } = cmpMatch;
    const CMP = { "<": "operator_lt", ">": "operator_gt", "=": "operator_equals" };
    if (CMP[op]) {
      return {
        kind: "boolean",
        opcode: CMP[op],
        inputs: { OPERAND1: parseExpr(left).node, OPERAND2: parseExpr(right).node },
        fields: {},
      };
    }
    // Scratch has no <= or >= — rewrite: a<=b → not<a>b>, a>=b → not<a<b>
    if (op === "<=") {
      return {
        kind: "boolean",
        opcode: "operator_not",
        fields: {},
        inputs: {
          OPERAND: {
            kind: "boolean",
            opcode: "operator_gt",
            fields: {},
            inputs: { OPERAND1: parseExpr(left).node, OPERAND2: parseExpr(right).node },
          },
        },
      };
    }
    if (op === ">=") {
      return {
        kind: "boolean",
        opcode: "operator_not",
        fields: {},
        inputs: {
          OPERAND: {
            kind: "boolean",
            opcode: "operator_lt",
            fields: {},
            inputs: { OPERAND1: parseExpr(left).node, OPERAND2: parseExpr(right).node },
          },
        },
      };
    }
  }

  // not <expr>
  if (/^not\s+/i.test(inner)) {
    const operand = inner.replace(/^not\s+/i, "").trim();
    return { kind: "boolean", opcode: "operator_not", inputs: { OPERAND: parseExpr(operand).node }, fields: {} };
  }
  // key [KEY] pressed?
  const keyMatch = inner.match(/^key\s+\[(.+)\]\s+pressed\?$/i);
  if (keyMatch)
    return { kind: "boolean", opcode: "sensing_keypressed", inputs: {}, fields: { KEY_OPTION: [keyMatch[1], null] } };

  // mouse down?
  if (/^mouse down\?$/i.test(inner)) return { kind: "boolean", opcode: "sensing_mousedown", inputs: {}, fields: {} };

  // touching [thing]?
  const touchMatch = inner.match(/^touching\s+\[(.+)\]\?$/i);
  if (touchMatch)
    return {
      kind: "boolean",
      opcode: "sensing_touchingobject",
      inputs: {},
      fields: { TOUCHINGOBJECTMENU: [touchMatch[1], null] },
    };

  // touching color ... ?
  if (/^touching color /i.test(inner)) {
    const colMatch = inner.match(/^touching color\s+(.+)\?$/i);
    if (colMatch)
      return {
        kind: "boolean",
        opcode: "sensing_touchingcolor",
        inputs: { COLOR: { kind: "literal", value: colMatch[1] } },
        fields: {},
      };
  }

  // [list] contains ITEM?
  const listContainsMatch = inner.match(/^\[(.+)\]\s+contains\s+(.+)\?$/i);
  if (listContainsMatch)
    return {
      kind: "boolean",
      opcode: "data_listcontainsitem",
      inputs: { ITEM: parseExpr(listContainsMatch[2]).node },
      fields: { LIST: [stripV(listContainsMatch[1]), null] },
    };

  // STR contains STR?
  const strContainsMatch = inner.match(/^(.+)\s+contains\s+(.+)\?$/i);
  if (strContainsMatch)
    return {
      kind: "boolean",
      opcode: "operator_contains",
      inputs: { STRING1: parseExpr(strContainsMatch[1]).node, STRING2: parseExpr(strContainsMatch[2]).node },
      fields: {},
    };

  return { kind: "boolean", opcode: "unknown_boolean", inputs: {}, fields: {}, raw: inner };
}

const ARITH_OPS = {
  "+": "operator_add",
  "-": "operator_subtract",
  "*": "operator_multiply",
  "/": "operator_divide",
  mod: "operator_mod",
};

/** Split "a OP b" inside a paren expression, respecting nested delimiters. */
function splitBinaryOp(s) {
  const ops = ["mod", "+", "-", "*", "/"];
  for (const op of ops) {
    const idx = findOpOutside(s, op);
    if (idx !== -1) {
      return { left: s.slice(0, idx).trim(), op, right: s.slice(idx + op.length).trim() };
    }
  }
  return null;
}

function splitCompareOp(s) {
  // Normalize Unicode comparison chars that LLMs sometimes emit.
  s = s.replace(/≤/g, "<=").replace(/≥/g, ">=");
  // Walk the string tracking ()[], and also <> using extractBalanced to skip
  // nested angle brackets (booleans like <not <x = y>>).
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // Skip over balanced delimiters
    if (ch === "(" || ch === "[") {
      const closer = ch === "(" ? ")" : "]";
      const bal = extractBalanced(s.slice(i), ch, closer);
      if (bal) {
        i += bal.length;
        continue;
      }
    }
    if (ch === "<") {
      // Try to skip a balanced angle-bracket expression (boolean sub-expression)
      const bal = extractBalanced(s.slice(i), "<", ">");
      if (bal) {
        i += bal.length;
        continue;
      }
    }
    // At top level — check for comparison operators (multi-char first)
    if (s[i] === "<" && s[i + 1] === "=") return { left: s.slice(0, i).trim(), op: "<=", right: s.slice(i + 2).trim() };
    if (s[i] === ">" && s[i + 1] === "=") return { left: s.slice(0, i).trim(), op: ">=", right: s.slice(i + 2).trim() };
    if (s[i] === "<") return { left: s.slice(0, i).trim(), op: "<", right: s.slice(i + 1).trim() };
    if (s[i] === ">") return { left: s.slice(0, i).trim(), op: ">", right: s.slice(i + 1).trim() };
    if (s[i] === "=") return { left: s.slice(0, i).trim(), op: "=", right: s.slice(i + 1).trim() };
    i++;
  }
  return null;
}

function splitLogical(s, keyword) {
  // Use manual depth tracking for angle brackets instead of extractBalanced.
  // extractBalanced uses a last-'>' heuristic that consumes '<A> and <B>' as a
  // single unit, making splitLogical miss the 'and'/'or' between sub-expressions.
  // Simple rule: '<' opens a boolean sub-expression; the matching '>' (at pd=0,sd=0
  // when angleDepth>0) closes it; a bare '>' at angleDepth=0 is a comparison operator.
  const lower = s.toLowerCase();
  let i = 0,
    pd = 0,
    sd = 0,
    ad = 0; // paren, square, angle depths
  while (i < s.length) {
    // Check for keyword only at top level (all depths zero)
    if (pd === 0 && sd === 0 && ad === 0 && lower.startsWith(keyword, i)) {
      return { left: s.slice(0, i).trim(), right: s.slice(i + keyword.length).trim() };
    }
    const ch = s[i];
    if (ch === "(") {
      pd++;
    } else if (ch === ")") {
      if (pd > 0) pd--;
    } else if (ch === "[") {
      sd++;
    } else if (ch === "]") {
      if (sd > 0) sd--;
    } else if (ch === "<" && pd === 0 && sd === 0) {
      // Comparison < is only preceded by ) or ] — not any word char. Word chars like
      // 'd' in 'and' must NOT suppress a boolean opener. Also skip if followed by = (<=).
      let k = i - 1;
      while (k >= 0 && s[k] === " ") k--;
      if (!/[)\]]/.test(k >= 0 ? s[k] : "") && s[i + 1] !== "=") ad++;
    } else if (ch === ">" && sd === 0 && ad > 0) {
      // Comparison > is followed by ( or [ or = (>=) — not a boolean closer.
      let k = i + 1;
      while (k < s.length && s[k] === " ") k++;
      if (!/[(\[]/.test(k < s.length ? s[k] : "") && s[i + 1] !== "=") {
        pd = 0;
        ad--;
      }
    }
    // bare ">" at ad===0 is a comparison operator — skip without depth change
    i++;
  }
  return null;
}

/** Find the index of `op` in `s` that is NOT inside any bracket/paren/angle. */
function findOpOutside(s, op) {
  let depth = 0;
  for (let i = 0; i <= s.length - op.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "<") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === ">") {
      depth--;
      continue;
    }
    if (depth === 0) {
      const candidate = s.slice(i, i + op.length);
      // For single-char ops, make sure it's not part of a word (for "mod")
      if (op === "mod") {
        if (
          candidate.toLowerCase() === "mod" &&
          (i === 0 || /\s/.test(s[i - 1])) &&
          (i + 3 >= s.length || /\s/.test(s[i + 3]))
        ) {
          return i;
        }
      } else if (candidate === op) {
        // Don't match "-" as a binary op at position 0 (unary minus on literal)
        if (op === "-" && i === 0) continue;
        return i;
      }
    }
  }
  return -1;
}

/** Loosely split a string into N args, separating on whitespace at depth 0. */
function splitArgs(s, n) {
  const parts = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === ">") depth--;
    if (/\s/.test(ch) && depth === 0 && cur) {
      parts.push(cur);
      cur = "";
      if (parts.length >= n - 1) {
        cur = "";
        continue;
      }
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function unescapeVar(s) {
  return s.replace(/\\(.)/g, "$1");
}

/** Strip Scratch's trailing " v" dropdown indicator from variable/list names. */
function stripV(s) {
  return typeof s === "string" ? s.replace(/\s+v$/i, "") : s;
}

// ─── Line-level patterns ─────────────────────────────────────────────────────

// Hat block patterns — each returns { opcode, fields, inputs } or null
const HAT_PATTERNS = [
  // Green flag — many LLM variants accepted
  {
    re: /^(?:on green-flag|when green.?flag clicked|when flag clicked|when green flag is clicked):?$/i,
    parse: () => ({ opcode: "event_whenflagclicked", fields: {}, inputs: {} }),
  },
  // Key pressed
  {
    re: /^(?:on key \[(.+)\] pressed|when \[(.+)\] key pressed|when key \[(.+)\] is pressed):?$/i,
    parse: (m) => ({
      opcode: "event_whenkeypressed",
      fields: { KEY_OPTION: [m[0] ?? m[1] ?? m[2], null] },
      inputs: {},
    }),
  },
  // Sprite clicked
  {
    re: /^(?:on this sprite clicked|when this sprite is? clicked|when sprite clicked):?$/i,
    parse: () => ({ opcode: "event_whenthisspriteclicked", fields: {}, inputs: {} }),
  },
  // Stage clicked
  {
    re: /^(?:on stage clicked|when stage is? clicked):?$/i,
    parse: () => ({ opcode: "event_whenstageclicked", fields: {}, inputs: {} }),
  },
  // Broadcast received
  {
    re: /^(?:on receive \[(.+)\]|when I receive \[(.+)\]|when \[(.+)\] is received):?$/i,
    parse: (m) => ({
      opcode: "event_whenbroadcastreceived",
      fields: { BROADCAST_OPTION: [m[0] ?? m[1] ?? m[2], null] },
      inputs: {},
    }),
  },
  // Backdrop switches
  {
    re: /^(?:on backdrop switches to \[(.+)\]|when backdrop switches to \[(.+)\]):?$/i,
    parse: (m) => ({ opcode: "event_whenbackdropswitchesto", fields: { BACKDROP: [m[0] ?? m[1], null] }, inputs: {} }),
  },
  // Greater than sensor
  {
    re: /^on (.+) > (.+):?$/i,
    parse: (m) => ({
      opcode: "event_whengreaterthan",
      fields: { WHENGREATERTHANMENU: [m[0], null] },
      inputs: { VALUE: parseExpr(m[1]).node },
    }),
  },
  // Clone start
  {
    re: /^(?:on start as clone|when I start as a clone):?$/i,
    parse: () => ({ opcode: "control_start_as_clone", fields: {}, inputs: {} }),
  },
  // Custom block definition — "define warp ..." sets run-without-screen-refresh
  {
    re: /^define (.+):?$/i,
    parse: (m) => {
      const raw = m[0].replace(/:$/, "").trim();
      const warp = /^warp\s+/i.test(raw);
      const proccode = raw.replace(/^warp\s+/i, "").trim();
      return { opcode: "procedures_definition", fields: {}, inputs: {}, proccode, warp };
    },
  },
];

// C-block header patterns
const C_PATTERNS = [
  {
    // Accept with or without trailing colon
    re: /^forever:?$/,
    parse: () => ({ opcode: "control_forever", fields: {}, inputs: {}, noEnd: true }),
  },
  {
    // Must come before plain repeat — more specific
    re: /^repeat until (.+?)(?::)?$/,
    parse: (m) => {
      const cond = m[0].replace(/:$/, "").trim();
      return { opcode: "control_repeat_until", fields: {}, inputs: { CONDITION: parseExpr(cond).node } };
    },
  },
  {
    // Accept with or without trailing colon; negative lookahead prevents matching "repeat until"
    re: /^repeat (?!until\s)(.+?)(?:\s+times:?|:)?$/,
    parse: (m) => {
      const times = m[0]
        .replace(/\s+times:?$/, "")
        .replace(/:$/, "")
        .trim();
      return { opcode: "control_repeat", fields: {}, inputs: { TIMES: parseExpr(times).node } };
    },
  },
  {
    // Accept "if COND then:", "if COND:", or bare "if COND"
    // Use (.+) greedy then strip trailing " then" from the captured condition.
    re: /^if (.+?)(?:\s+then:?|:)?$/,
    parse: (m) => {
      const cond = m[0]
        .replace(/\s+then:?$/, "")
        .replace(/:$/, "")
        .trim();
      return { opcode: "control_if", fields: {}, inputs: { CONDITION: parseExpr(cond).node }, hasElse: false };
    },
  },
];

// Statement patterns (order matters — more specific first)
const STMT_PATTERNS = [
  // Motion
  { re: /^move (.+) steps$/, parse: (m) => stmt("motion_movesteps", { STEPS: m[0] }) },
  { re: /^turn right (.+) degrees$/, parse: (m) => stmt("motion_turnright", { DEGREES: m[0] }) },
  { re: /^turn left (.+) degrees$/, parse: (m) => stmt("motion_turnleft", { DEGREES: m[0] }) },
  { re: /^go to x: (.+) y: (.+)$/, parse: (m) => stmt("motion_gotoxy", { X: m[0], Y: m[1] }) },
  { re: /^go to (.+)$/, parse: (m) => stmtSlot("motion_goto", "TO", m[0]) },
  {
    re: /^glide (.+) secs to x: (.+) y: (.+)$/,
    parse: (m) => stmt("motion_glidesecstoxy", { SECS: m[0], X: m[1], Y: m[2] }),
  },
  { re: /^glide (.+) secs to (.+)$/, parse: (m) => stmt("motion_glideto", { SECS: m[0], TO: m[1] }) },
  { re: /^point in direction (.+)$/, parse: (m) => stmt("motion_pointindirection", { DIRECTION: m[0] }) },
  { re: /^point towards (.+)$/, parse: (m) => stmtSlot("motion_pointtowards", "TOWARDS", m[0]) },
  { re: /^change x by (.+)$/, parse: (m) => stmt("motion_changexby", { DX: m[0] }) },
  { re: /^set x to (.+)$/, parse: (m) => stmt("motion_setx", { X: m[0] }) },
  { re: /^change y by (.+)$/, parse: (m) => stmt("motion_changeyby", { DY: m[0] }) },
  { re: /^set y to (.+)$/, parse: (m) => stmt("motion_sety", { Y: m[0] }) },
  { re: /^if on edge, bounce$/, parse: () => stmtSimple("motion_ifonedgebounce") },
  { re: /^set rotation style \[(.+)\]$/, parse: (m) => stmtField("motion_setrotationstyle", "STYLE", m[0]) },

  // Looks
  { re: /^say (.+) for (.+) secs$/, parse: (m) => stmt("looks_sayforsecs", { MESSAGE: m[0], SECS: m[1] }) },
  { re: /^say (.+)$/, parse: (m) => stmt("looks_say", { MESSAGE: m[0] }) },
  { re: /^think (.+) for (.+) secs$/, parse: (m) => stmt("looks_thinkforsecs", { MESSAGE: m[0], SECS: m[1] }) },
  { re: /^think (.+)$/, parse: (m) => stmt("looks_think", { MESSAGE: m[0] }) },
  { re: /^switch costume to (.+)$/, parse: (m) => stmtSlot("looks_switchcostumeto", "COSTUME", m[0]) },
  { re: /^next costume$/, parse: () => stmtSimple("looks_nextcostume") },
  { re: /^switch backdrop to (.+)$/, parse: (m) => stmtSlot("looks_switchbackdropto", "BACKDROP", m[0]) },
  { re: /^next backdrop$/, parse: () => stmtSimple("looks_nextbackdrop") },
  { re: /^change size by (.+)$/, parse: (m) => stmt("looks_changesizeby", { CHANGE: m[0] }) },
  { re: /^set size to (.+)%$/, parse: (m) => stmt("looks_setsizeto", { SIZE: m[0] }) },
  {
    re: /^change \[(.+)\] effect by (.+)$/,
    parse: (m) => stmtFieldInput("looks_changeeffectby", "EFFECT", m[0], "CHANGE", m[1]),
  },
  {
    re: /^set \[(.+)\] effect to (.+)$/,
    parse: (m) => stmtFieldInput("looks_seteffectto", "EFFECT", m[0], "VALUE", m[1]),
  },
  { re: /^clear graphic effects$/, parse: () => stmtSimple("looks_cleargraphiceffects") },
  { re: /^show$/, parse: () => stmtSimple("looks_show") },
  { re: /^hide$/, parse: () => stmtSimple("looks_hide") },
  { re: /^go to (front|back)$/, parse: (m) => stmtField("looks_gotofrontback", "FRONT_BACK", m[0]) },
  {
    re: /^go (forward|backward) (.+) layers$/,
    parse: (m) => stmtFieldInput("looks_goforwardbackwardlayers", "FORWARD_BACKWARD", m[0], "NUM", m[1]),
  },

  // Sound
  { re: /^play sound (.+) until done$/, parse: (m) => stmtSlot("sound_playuntildone", "SOUND_MENU", m[0]) },
  { re: /^start sound (.+)$/, parse: (m) => stmtSlot("sound_play", "SOUND_MENU", m[0]) },
  { re: /^stop all sounds$/, parse: () => stmtSimple("sound_stopallsounds") },
  {
    re: /^change \[(.+)\] effect by (.+)$/,
    parse: (m) => stmtFieldInput("sound_changeeffectby", "EFFECT", m[0], "VALUE", m[1]),
  },
  {
    re: /^set \[(.+)\] effect to (.+)$/,
    parse: (m) => stmtFieldInput("sound_seteffectto", "EFFECT", m[0], "VALUE", m[1]),
  },
  { re: /^clear sound effects$/, parse: () => stmtSimple("sound_cleareffects") },
  { re: /^change volume by (.+)$/, parse: (m) => stmt("sound_changevolumeby", { VOLUME: m[0] }) },
  { re: /^set volume to (.+)%$/, parse: (m) => stmt("sound_setvolumeto", { VOLUME: m[0] }) },

  // Events
  { re: /^broadcast (.+) and wait$/, parse: (m) => stmt("event_broadcastandwait", { BROADCAST_INPUT: m[0] }) },
  { re: /^broadcast (.+)$/, parse: (m) => stmt("event_broadcast", { BROADCAST_INPUT: m[0] }) },

  // Control (non-C)
  { re: /^wait (.+) secs$/, parse: (m) => stmt("control_wait", { DURATION: m[0] }) },
  { re: /^wait until (.+)$/, parse: (m) => stmt("control_wait_until", { CONDITION: m[0] }) },
  // Bare stop variants (no brackets) — must come before the bracketed form
  { re: /^stop all$/, parse: () => stmtField("control_stop", "STOP_OPTION", "all") },
  { re: /^stop this script$/, parse: () => stmtField("control_stop", "STOP_OPTION", "this script") },
  // 'break' is not a Scratch block — treat as 'stop this script' (closest equivalent)
  { re: /^break$/, parse: () => stmtField("control_stop", "STOP_OPTION", "this script") },
  {
    re: /^stop other scripts(?: in sprite)?$/,
    parse: () => stmtField("control_stop", "STOP_OPTION", "other scripts in sprite"),
  },
  { re: /^stop \[(.+)\]$/, parse: (m) => stmtField("control_stop", "STOP_OPTION", stripV(m[0])) },
  { re: /^create clone of (.+)$/, parse: (m) => stmtSlot("control_create_clone_of", "CLONE_OPTION", m[0]) },
  { re: /^delete this clone$/, parse: () => stmtSimple("control_delete_this_clone") },

  // Sensing
  { re: /^ask (.+) and wait$/, parse: (m) => stmt("sensing_askandwait", { QUESTION: m[0] }) },
  { re: /^reset timer$/, parse: () => stmtSimple("sensing_resettimer") },
  { re: /^set drag mode \[(.+)\]$/, parse: (m) => stmtField("sensing_setdragmode", "DRAG_MODE", m[0]) },

  // Variables
  { re: /^set \[(.+)\] to (.+)$/, parse: (m) => stmtFieldInput("data_setvariableto", "VARIABLE", m[0], "VALUE", m[1]) },
  // Lenient form: AI sometimes writes (varname) in parens instead of [varname]
  {
    re: /^set \(([^)]+)\) to (.+)$/,
    parse: (m) => stmtFieldInput("data_setvariableto", "VARIABLE", m[0], "VALUE", m[1]),
  },
  {
    re: /^change \[(.+)\] by (.+)$/,
    parse: (m) => stmtFieldInput("data_changevariableby", "VARIABLE", m[0], "VALUE", m[1]),
  },
  {
    re: /^change \(([^)]+)\) by (.+)$/,
    parse: (m) => stmtFieldInput("data_changevariableby", "VARIABLE", m[0], "VALUE", m[1]),
  },
  { re: /^show variable \[(.+)\]$/, parse: (m) => stmtField("data_showvariable", "VARIABLE", m[0]) },
  { re: /^hide variable \[(.+)\]$/, parse: (m) => stmtField("data_hidevariable", "VARIABLE", m[0]) },

  // Lists — 'delete all of' must come before generic 'delete (.+) of'
  { re: /^add (.+) to \[(.+)\]$/, parse: (m) => stmtInputField("data_addtolist", "ITEM", m[0], "LIST", m[1]) },
  { re: /^delete all of \[(.+)\]$/, parse: (m) => stmtField("data_deletealloflist", "LIST", m[0]) },
  { re: /^delete (.+) of \[(.+)\]$/, parse: (m) => stmtInputField("data_deleteoflist", "INDEX", m[0], "LIST", m[1]) },
  { re: /^insert (.+) at (.+) of \[(.+)\]$/, parse: (m) => stmtInsert(m[0], m[1], m[2]) },
  { re: /^replace item (.+) of \[(.+)\] with (.+)$/, parse: (m) => stmtReplace(m[0], m[1], m[2]) },
  { re: /^show list \[(.+)\]$/, parse: (m) => stmtField("data_showlist", "LIST", m[0]) },
  { re: /^hide list \[(.+)\]$/, parse: (m) => stmtField("data_hidelist", "LIST", m[0]) },
];

// ─── Statement builder helpers ────────────────────────────────────────────────

function stmt(opcode, inputMap) {
  const inputs = {};
  for (const [k, v] of Object.entries(inputMap)) inputs[k] = parseExpr(String(v)).node;
  return { opcode, fields: {}, inputs };
}
function stmtSimple(opcode) {
  return { opcode, fields: {}, inputs: {} };
}
function stmtField(opcode, fieldName, value) {
  const fval = fieldName === "VARIABLE" || fieldName === "LIST" ? stripV(value) : value;
  return { opcode, fields: { [fieldName]: [fval, null] }, inputs: {} };
}
function stmtSlot(opcode, inputName, raw) {
  // Slot values may be [menu] or (reporter)
  const node = parseExpr(raw).node ?? { kind: "literal", value: raw };
  return { opcode, fields: {}, inputs: { [inputName]: node } };
}
function stmtFieldInput(opcode, fieldName, fieldVal, inputName, inputVal) {
  const fval = fieldName === "VARIABLE" || fieldName === "LIST" ? stripV(fieldVal) : fieldVal;
  return { opcode, fields: { [fieldName]: [fval, null] }, inputs: { [inputName]: parseExpr(String(inputVal)).node } };
}
function stmtInputField(opcode, inputName, inputVal, fieldName, fieldVal) {
  const fval = fieldName === "VARIABLE" || fieldName === "LIST" ? stripV(fieldVal) : fieldVal;
  return { opcode, inputs: { [inputName]: parseExpr(String(inputVal)).node }, fields: { [fieldName]: [fval, null] } };
}
function stmtInsert(item, index, list) {
  return {
    opcode: "data_insertatlist",
    inputs: { ITEM: parseExpr(item).node, INDEX: parseExpr(index).node },
    fields: { LIST: [stripV(list), null] },
  };
}
function stmtReplace(index, list, item) {
  return {
    opcode: "data_replaceitemoflist",
    inputs: { INDEX: parseExpr(index).node, ITEM: parseExpr(item).node },
    fields: { LIST: [stripV(list), null] },
  };
}

// ─── Line classifier ──────────────────────────────────────────────────────────

function classifyLine(raw) {
  const line = raw.trim();

  // Strip trailing comment
  const noComment = line.replace(/\s*\/\/.*$/, "").trim();

  // Blank / divider
  if (!noComment || /^[═=─-]{4,}$/.test(noComment)) return { kind: "blank" };

  // Markdown code fences, horizontal rules, and prose decorators — skip entirely.
  // These appear when the LLM wraps code in a markdown block and adds explanation text.
  if (/^```/.test(noComment)) return { kind: "meta" };
  if (/^---+$/.test(noComment)) return { kind: "meta" };
  if (/^\*\*/.test(noComment)) return { kind: "meta" };
  if (/^#+\s/.test(noComment)) return { kind: "meta" }; // markdown headings

  // Citation header lines (e.g. "Sprite2 | on green-flag | [→ blockId]" or
  // "on green-flag:  [→ blockId]") — metadata from the AI response, not real statements.
  if (noComment.includes("\u2192")) return { kind: "meta" };

  // Sprite / stage headers
  if (/^SPRITE:\s/.test(noComment)) return { kind: "sprite-header", name: noComment.slice(8).trim() };
  if (/^STAGE$/.test(noComment)) return { kind: "stage-header" };

  // Metadata lines (costumes:, sounds:, variables, lists)
  if (/^(costumes|backdrops|sounds|variables|lists)\s*(\(.*\))?\s*:/.test(noComment)) return { kind: "meta" };
  // Variable/list value lines from projectToPseudocode output are indented with 2+ spaces
  // and look like "  varname = value" — a plain identifier (no brackets/parens/angle) before =.
  // Must NOT match pseudocode lines like "repeat until <x = y>:".
  if (
    /^\s{2,}/.test(raw) &&
    /^[A-Za-z_][\w\s]*=[^=]/.test(noComment) &&
    !/^(repeat|if|set|change|replace|add|delete|insert|stop|say|think|move|go|glide|point|turn|broadcast|wait|create|when|on|define|forever|else|end)\b/i.test(
      noComment
    )
  )
    return { kind: "meta" };
  // SCRIPT header lines (e.g. "SCRIPT #1:" or "SCRIPT #1:  [→ id]")
  if (/^SCRIPT\s+#\d+/.test(noComment)) return { kind: "meta" };

  // else: / end / brace-style closer
  if (noComment === "else:" || noComment === "else") return { kind: "else" };
  if (noComment === "end" || noComment === "}") return { kind: "end" };

  // Strip trailing " {" (brace-style block openers, e.g. "repeat (5) {", "if <cond> then {")
  const noBrace = noComment.replace(/\s*\{\s*$/, "");

  // Hat blocks
  for (const pat of HAT_PATTERNS) {
    const m = noBrace.match(pat.re);
    if (m) {
      const result = pat.parse(m.slice(1));
      return { kind: "hat", ...result, raw: noBrace };
    }
  }

  // C-block headers
  for (const pat of C_PATTERNS) {
    const m = noBrace.match(pat.re);
    if (m) {
      const result = pat.parse(m.slice(1));
      return { kind: "c-header", ...result, raw: noBrace };
    }
  }

  // Statement
  for (const pat of STMT_PATTERNS) {
    const m = noBrace.match(pat.re);
    if (m) {
      const result = pat.parse(m.slice(1));
      return { kind: "statement", ...result, raw: noBrace };
    }
  }

  // Extension / unknown block [opcode | ...]
  const extMatch = noBrace.match(/^\[([^\]]+)\]$/);
  if (extMatch) return { kind: "extension", raw: noBrace, opcode: extMatch[1].split("|")[0].trim() };

  // Procedure call — anything that doesn't match the above and isn't a known keyword
  // (will be treated as procedures_call with the raw proccode)
  return { kind: "proc-call", proccode: noBrace, raw: noBrace };
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a pseudocode string into an array of Script ASTs.
 *
 * @param {string} text  Full pseudocode text from projectToPseudocode()
 * @returns {{ scripts: object[], warnings: object[] }}
 */
export function parsePseudocode(text) {
  // Normalize Unicode comparison characters that LLMs sometimes emit.
  text = text.replace(/≤/g, "<=").replace(/≥/g, ">=");

  const warnings = [];
  const scripts = [];

  let currentSprite = null;
  let currentIsStage = false;

  // Stack-based parser: each entry is { type, node, body, elseBody, inElse }
  // type: "root" | "script" | "c-block"
  const stack = [];
  let currentScript = null;

  const warn = (lineNo, msg, raw) => {
    warnings.push({ lineNo, message: msg, raw });
    console.warn(`[inspector:parser] Line ${lineNo}: ${msg} | raw: ${JSON.stringify(raw)}`);
  };

  const lines = text.split("\n");

  const pushNode = (node) => {
    if (!currentScript) {
      // Statement outside any hat — create a hatless script
      currentScript = { type: "script", spriteName: currentSprite, isStage: currentIsStage, hat: null, body: [] };
    }
    if (stack.length === 0) {
      currentScript.body.push(node);
    } else {
      const top = stack[stack.length - 1];
      if (top.inElse) top.elseBody.push(node);
      else top.body.push(node);
    }
  };

  const closeScript = () => {
    while (stack.length > 0) {
      const top = stack.pop();
      const cNode = {
        type: "c-block",
        opcode: top.opcode,
        fields: top.fields,
        inputs: top.inputs,
        body: top.body,
        elseBody: top.elseBody,
        noEnd: top.noEnd,
        raw: top.raw,
      };
      // noEnd blocks (forever:) legitimately have no 'end' in the pseudocode — close silently.
      // Everything else is a real parse problem worth reporting.
      if (!top.noEnd) {
        warn(0, `Unclosed ${top.opcode} block (missing 'end')`, top.raw ?? "");
      }
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (parent.inElse) parent.elseBody.push(cNode);
        else parent.body.push(cNode);
      } else if (currentScript) {
        currentScript.body.push(cNode);
      }
    }
    if (currentScript) {
      scripts.push(currentScript);
      currentScript = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const indent = raw.match(/^(\s*)/)[1].length;
    const cl = classifyLine(raw);

    switch (cl.kind) {
      case "blank":
        // Blank lines are for readability — don't close the script. Scripts are only
        // closed by a new hat block, sprite/stage header, or end of input.
        break;

      case "sprite-header":
        closeScript();
        currentSprite = cl.name;
        currentIsStage = false;
        break;

      case "stage-header":
        closeScript();
        currentSprite = "Stage";
        currentIsStage = true;
        break;

      case "meta":
        // metadata lines (costumes, variables, etc.) — ignore for block conversion
        break;

      case "hat": {
        closeScript();
        currentScript = {
          type: "script",
          spriteName: currentSprite,
          isStage: currentIsStage,
          hat: {
            type: "hat",
            opcode: cl.opcode,
            fields: cl.fields,
            inputs: cl.inputs,
            proccode: cl.proccode,
            warp: cl.warp ?? false,
            raw: cl.raw,
          },
          body: [],
        };
        break;
      }

      case "c-header": {
        const cEntry = {
          opcode: cl.opcode,
          fields: cl.fields ?? {},
          inputs: cl.inputs ?? {},
          noEnd: cl.noEnd,
          raw: cl.raw,
          body: [],
          elseBody: null,
          inElse: false,
        };
        stack.push(cEntry);
        break;
      }

      case "else": {
        if (stack.length === 0) {
          warn(lineNo, "'else' without open if block", raw);
          break;
        }
        const top = stack[stack.length - 1];
        if (top.opcode !== "control_if") {
          warn(lineNo, "'else' on non-if block", raw);
        }
        // Upgrade control_if → control_if_else
        top.opcode = "control_if_else";
        top.elseBody = [];
        top.inElse = true;
        break;
      }

      case "end": {
        if (stack.length === 0) {
          warn(lineNo, "'end' without open block", raw);
          break;
        }
        // Skip any noEnd blocks (e.g. forever:) that sit above the one being closed —
        // they are silently closed because they never emit 'end' in pseudocode.
        while (stack.length > 1 && stack[stack.length - 1].noEnd) {
          const noEndBlock = stack.pop();
          const noEndNode = {
            type: "c-block",
            opcode: noEndBlock.opcode,
            fields: noEndBlock.fields,
            inputs: noEndBlock.inputs,
            body: noEndBlock.body,
            elseBody: noEndBlock.elseBody,
            noEnd: true,
            raw: noEndBlock.raw,
          };
          const parent = stack[stack.length - 1];
          if (parent.inElse) parent.elseBody.push(noEndNode);
          else parent.body.push(noEndNode);
        }
        const top = stack.pop();
        const cNode = {
          type: "c-block",
          opcode: top.opcode,
          fields: top.fields,
          inputs: top.inputs,
          body: top.body,
          elseBody: top.elseBody,
          noEnd: top.noEnd,
          raw: top.raw,
        };
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent.inElse) parent.elseBody.push(cNode);
          else parent.body.push(cNode);
        } else {
          pushNode(cNode);
        }
        break;
      }

      case "statement": {
        pushNode({
          type: "statement",
          opcode: cl.opcode,
          fields: cl.fields ?? {},
          inputs: cl.inputs ?? {},
          raw: cl.raw,
        });
        break;
      }

      case "extension": {
        warn(lineNo, `Extension block not supported for injection: ${cl.opcode}`, raw);
        pushNode({ type: "unknown", raw: cl.raw });
        break;
      }

      case "proc-call": {
        // Could be a procedures_call — keep the proccode for later resolution
        pushNode({
          type: "statement",
          opcode: "procedures_call",
          fields: {},
          inputs: {},
          proccode: cl.proccode,
          raw: cl.raw,
        });
        break;
      }

      default:
        warn(lineNo, `Unrecognised line`, raw);
        pushNode({ type: "unknown", raw: cl.raw ?? raw.trim() });
    }
  }

  closeScript();

  // ── Structured DevTools output ────────────────────────────────────────────
  const realWarnings = warnings.filter((w) => w.lineNo !== 0 || w.message.includes("missing"));
  const label = `[inspector:parser] ${scripts.length} scripts, ${realWarnings.length} warning(s)`;
  console.groupCollapsed(label);
  console.groupCollapsed("  📋 Full input text");
  console.log(text);
  console.groupEnd();
  for (const s of scripts) {
    const hatLabel = s.hat?.raw ?? "(hatless)";
    console.groupCollapsed(`  📄 ${s.spriteName ?? "?"}  |  ${hatLabel}  (${s.body.length} top-level nodes)`);
    console.log("hat:", s.hat);
    console.log("body:", s.body);
    console.groupEnd();
  }
  if (realWarnings.length > 0) {
    console.groupCollapsed(`  ⚠️ Warnings (${realWarnings.length})`);
    for (const w of realWarnings) console.warn(`    Line ${w.lineNo}: ${w.message}`, w.raw ?? "");
    console.groupEnd();
  }
  console.groupEnd();

  return { scripts, warnings };
}
