# Pseudocode → Scratch Blocks Converter

Goal: convert the pseudocode produced by `projectToPseudocode` back into live Scratch
blocks and inject them into the workspace via `vm.shareBlocksToTarget`.

## Architecture

```
pseudocode text
      │
      ▼
pseudocode-parser.js   parsePseudocode(text) → { scripts, warnings }
      │
      ▼
ast-to-blocks.js       astToBlocks(script, vm) → ScratchBlock[]
      │
      ▼
scratch-injector.js    injectBlocks(vm, blocks, x, y)
```

## Files

| File | Status | Description |
|---|---|---|
| `pseudocode-parser.js` | ✅ Done (v1) | Parses pseudocode text → AST |
| `ast-to-blocks.js` | ⬜ TODO | Converts AST → Scratch VM block JSON |
| `scratch-injector.js` | ⬜ TODO | Calls `vm.shareBlocksToTarget` |

## Pseudocode format (reference)

Produced by `projectToPseudocode` / `targetToPseudocode`:

```
════════════════════════════════════════════════
SPRITE: Sprite2
  costumes: costume1, costume2
  sounds: pop
  variables (local):
    score = 0

on green-flag:
  set size to (100)%
  forever:
    if <key [up arrow] pressed?> then:
      change y by (-7)
    end
  end

on key [space] pressed:
  say [Hello] for (2) secs

define jump (height) times <is fast>:
  repeat (height):
    change y by (10)
  end
```

### Expression syntax

| Syntax | Meaning |
|---|---|
| `(value)` | Number literal or variable reporter |
| `[value]` | String / menu value |
| `[""]` | Empty string |
| `<expr>` | Boolean expression |
| `(name)` | Variable reporter (bare name in parens) |
| `[name]` | List/broadcast/menu value |

### Known C-blocks

- `forever:` … (no `end`)
- `repeat (N):` … `end`
- `repeat until <cond>:` … `end`
- `if <cond> then:` … `end`
- `if <cond> then:` … `else:` … `end`

### Known hat blocks

- `on green-flag:`
- `on key [KEY] pressed:`
- `on this sprite clicked:`
- `on stage clicked:`
- `on receive [MSG]:`
- `on backdrop switches to [BACKDROP]:`
- `on [SENSOR] > (VALUE):`
- `on start as clone:`
- `define PROCCODE:`

## AST node types

```js
// Script (a hat + its body)
{ type: "script", hat: HatNode | null, body: Node[], spriteName: string }

// Hat
{ type: "hat", opcode: string, fields: {}, inputs: {}, raw: string }

// Statement
{ type: "statement", opcode: string, fields: {}, inputs: {}, raw: string }

// C-block
{ type: "c-block", opcode: string, fields: {}, inputs: {},
  body: Node[], elseBody: Node[] | null, raw: string }

// Unknown line (no pattern matched)
{ type: "unknown", raw: string }
```

## Progress log

### v1 — 2026-06-11
- Created module structure
- `pseudocode-parser.js`: full line-by-line parser with indentation stack
- Parses all hat blocks, C-blocks, statements from the converter's STATEMENT_FORMATTERS
- Expression parser handles `(...)`, `[...]`, `<...>`, operators, booleans, reporters
- Returns structured warnings for unrecognised lines
- Test button in panel shows AST + warnings in the Issues tab

### TODO (ast-to-blocks.js)
- Generate Scratch VM block JSON from AST
- Assign fresh UUIDs to all blocks
- Resolve variable names to IDs from `vm.editingTarget`
- Handle nested expressions (inputs pointing to reporter blocks)
- Handle C-blocks (SUBSTACK links)

### TODO (scratch-injector.js)
- Call `vm.shareBlocksToTarget(blocks, targetId)`
- Position blocks at a sensible x/y (below existing scripts or at cursor)
- Show confirm dialog before injecting (destructive if replacing)

### Known limitations / future work
- Comments (`//`) are stripped on parse — not injected
- Procedure definitions require the custom block to already exist (or create it)
- Extension blocks (`[opcode | ...]`) are not yet reverse-mapped
- Variable / list IDs must be resolved from the live VM at inject time
