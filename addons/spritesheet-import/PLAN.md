# Sprite Sheet Import Addon — Implementation Plan

## Overview

Adds an **"Upload Sprite Sheet"** entry to the costume-tab action menu. The user picks an
image file; a modal dialog lets them set up a tile grid (auto-detected or manual), toggle
which tiles to import, choose a costume-name prefix and anchor point, then batch-imports all
selected tiles as bitmap costumes into the active sprite.

---

## User flow

```
[Choose a Costume menu]
  └─ Upload Sprite Sheet
        │
        ▼ file picker (single image)
        │
        ▼ SpriteSheetDialog opens
        ┌─────────────────────────────────────────────────────┐
        │  [Image preview with tile-grid overlay]             │
        │  Columns: [4 ▲▼]  Rows: [4 ▲▼]  [Auto-detect]    │
        │                                                     │
        │  ┌────┬────┬────┬────┐                             │
        │  │ ✓  │ ✓  │ ✗  │ ✓  │  ← tile grid               │
        │  ├────┼────┼────┼────┤    (click = toggle)         │
        │  │ ✓  │ ✗  │ ✓  │ ✓  │    (drag rect = bulk)       │
        │  └────┴────┴────┴────┘                             │
        │  [Select All]  [Clear All]                          │
        │                                                     │
        │  Name: [player_walk________]                        │
        │                                                     │
        │  Anchor:  ┌───┬───┬───┐                            │
        │           │ ○ │ ○ │ ○ │  (3×3 anchor picker)       │
        │           ├───┼───┼───┤                            │
        │           │ ○ │ ● │ ○ │  ← centre selected         │
        │           ├───┼───┼───┤                            │
        │           │ ○ │ ○ │ ○ │                            │
        │           └───┴───┴───┘                            │
        │                                                     │
        │                   [Cancel]  [Import N costumes]     │
        └─────────────────────────────────────────────────────┘
```

---

## Costume naming

Each imported tile is named:

```
{baseName}:{col}:{row}
```

- `col` and `row` are 1-indexed, matching the tile's column and row in the grid.
- Example: `player_walk:2:1` is column 2, row 1.

### Conflict resolution

When a costume with the same name already exists:
- If content is **pixel-identical** (matching MD5/hash) → **skip**.
- Otherwise → **replace** (remove old, insert at same index, new asset).

---

## Auto-detection algorithm (`SpriteSheetAnalyzer`)

1. Enumerate all divisor pairs `(cols, rows)` where `cols` divides `imgWidth` and
   `rows` divides `imgHeight`. Cap at 64 per axis to avoid pathological images.
2. For each candidate, compute a **boundary transparency score**:
   - Sample every pixel on each inter-tile column boundary and row boundary.
   - Score = `mean alpha of boundary pixels`. Lower alpha → better score.
3. Rank candidates by score ascending (most-transparent boundaries first).
4. The best candidate is pre-selected. A confidence indicator (high / medium / low)
   is shown to the user, who can override via the column/row spinners at any time.
5. **Edge case — no transparent gutters**: if all candidates score above a threshold
   (opaque sheet), fall back to the smallest plausible divisor pair (e.g., 4×4 or 1×1
   if the image is not divisible), and show a "could not auto-detect" notice.

---

## Blank tile detection

A tile is considered blank if **every pixel is fully transparent** (alpha === 0).
Blank tiles are auto-deselected in the dialog. The user can re-select them manually.

---

## Anchor position

A 3×3 grid of 9 selectable points. Maps to `(rotationCenterX, rotationCenterY)`:

| Position   | X             | Y              |
|------------|---------------|----------------|
| top-left   | 0             | 0              |
| top-center | tileW / 2     | 0              |
| top-right  | tileW         | 0              |
| mid-left   | 0             | tileH / 2      |
| center     | tileW / 2     | tileH / 2      |
| mid-right  | tileW         | tileH / 2      |
| bot-left   | 0             | tileH          |
| bot-center | tileW / 2     | tileH          |
| bot-right  | tileW         | tileH          |

`bitmapResolution` is always `2` (Scratch's 2× bitmap standard).
`rotationCenterX/Y` values are in Scratch's coordinate system (half-pixels for 2× bitmaps,
so the actual center offset is `anchorX * bitmapResolution`).

---

## Import process (`SpriteSheetImporter`)

For each selected tile (left-to-right, top-to-bottom order):

1. Draw the tile sub-rectangle onto an off-screen `<canvas>`.
2. `canvas.toBlob('image/png')` → `ArrayBuffer`.
3. Hash the buffer (simple djb2 or SHA-1 via `crypto.subtle`) for identity checking.
4. Check existing costumes for name clash:
   - No clash → add.
   - Clash + identical hash → skip.
   - Clash + different hash → delete old, insert at same index.
5. Call `vm.addCostume(md5ext, costumeObj, targetId)` with the correct
   `rotationCenterX`, `rotationCenterY`, `bitmapResolution`.

The import runs sequentially (not parallel) to preserve costume ordering.

---

## File structure

```
addons/spritesheet-import/
  addon.json                — Manifest
  icon.svg                  — Menu button icon
  userscript.js             — Entry point; injects menu item
  userstyle.css             — Dialog & button styles
  SpriteSheetWorker.js      — Grid auto-detection, blank detection, tile hash (Web Worker)
  SpriteSheetTileGrid.js    — Canvas tile-grid overlay, click/drag selection
  SpriteSheetDialog.js      — Modal dialog DOM + state management
  SpriteSheetImporter.js    — Costume creation & VM interaction
```

---

## Class responsibilities

### `SpriteSheetWorker` (Blob Web Worker)

Runs off the main thread. Receives an `ImageBitmap` (transferred zero-copy),
precomputes per-column/row boundary sums, then handles two messages:

- `init` → `ready`: detectGrid → detectPadding → classifyTiles → post results
- `classify` → `classified`: reclassify with new cols/rows → post blank set + hashes

### `SpriteSheetTileGrid`

Renders onto an absolutely-positioned `<canvas>` overlaid on the preview image.

```
constructor(canvas, cols, rows, selectedSet)
setGrid(cols, rows)             — re-renders with new dimensions
setSelected(col, row, value)    — toggle a tile
selectAll() / clearAll()
getSelectedSet()                → Set<"col:row">
onSelectionChange               — callback invoked after any change
```

Mouse events:
- **Click**: toggle the clicked tile.
- **Mouse-down + drag + mouse-up**: determine rectangle of tiles; set all to the
  opposite of the state of the first-clicked tile (consistent with common tile editors).

### `SpriteSheetDialog`

```
constructor(addon, msg)
open(imageFile)                 → Promise<ImportSpec | null>
  // resolves with { tiles: [{col,row}], baseName, anchorIndex } or null on cancel
close()
```

Internally manages:
- `_cols`, `_rows` (spinners)
- `_selected` (Set)
- `_anchorIndex` (0–8)
- `_baseName` (text input)
- `_tileGrid` (SpriteSheetTileGrid instance)

### `SpriteSheetImporter`

```
constructor(vm, storage, addon)
import(imageElement, spec)      → Promise<void>
  // spec: { tiles, baseName, anchorIndex, cols, rows }
```

---

## Addon settings

None required for v1 (all options are per-import in the dialog).

---

## i18n keys (`addons-l10n/en/spritesheet-import.json`)

| Key | String |
|-----|--------|
| `spritesheet-import/menu-item` | `Upload Sprite Sheet` |
| `spritesheet-import/dialog-title` | `Import Sprite Sheet` |
| `spritesheet-import/columns` | `Columns` |
| `spritesheet-import/rows` | `Rows` |
| `spritesheet-import/auto-detect` | `Auto-detect` |
| `spritesheet-import/auto-detect-confidence-high` | `Auto-detected (high confidence)` |
| `spritesheet-import/auto-detect-confidence-medium` | `Auto-detected (medium confidence)` |
| `spritesheet-import/auto-detect-confidence-low` | `Could not auto-detect — please set manually` |
| `spritesheet-import/select-all` | `Select All` |
| `spritesheet-import/clear-all` | `Clear All` |
| `spritesheet-import/name-label` | `Costume name` |
| `spritesheet-import/anchor-label` | `Anchor` |
| `spritesheet-import/cancel` | `Cancel` |
| `spritesheet-import/import-button` | `Import {count} costume(s)` |
| `spritesheet-import/importing` | `Importing…` |

---

## Addon manifest (`addon.json`) highlights

- `matches: ["projects"]`
- `dynamicEnable: true`, `dynamicDisable: true`
- No special permissions needed (canvas + Blob APIs are available in page context)

---

## Implementation order

1. **Scaffold**: `addon.json`, register in `addons.json`, `icon.svg`, i18n file.
2. **`userscript.js`**: inject menu item (mirror `better-img-uploads` pattern),
   wire file-picker click → open dialog.
3. **`SpriteSheetWorker`**: image analysis off-thread, blank detection, auto-detect.
4. **`SpriteSheetTileGrid`**: canvas overlay, mouse interaction.
5. **`SpriteSheetDialog`**: full modal with all controls, wired to Analyzer + TileGrid.
6. **`SpriteSheetImporter`**: tile extraction → `vm.addCostume`.
7. **`userstyle.css`**: dialog layout, tile grid overlay, anchor picker, dark-mode
   support via `addon.tab.scratchClass` color variables.
8. **Polish**: loading state, error handling, disable while importing.

---

## Known constraints & notes

- Scratch's `vm.addCostume(md5ext, costumeObj, targetId)` is the correct low-level
  API (used by `costume-tab.jsx`). The `md5ext` is stored in the vm asset; we supply
  it via `storage.createAsset(...)` the same way `costumeUpload` in `file-uploader.js`
  does via `createVMAsset`.
- We **cannot** call `costumeUpload` directly from the addon (it is not exposed on the
  window). Instead, we replicate its PNG path: draw tile to canvas → `toBlob` → read as
  ArrayBuffer → `storage.createAsset(AssetType.ImageBitmap, DataFormat.PNG, data)` →
  construct vmCostume object → `vm.addCostume`.
- The `storage` instance is `vm.runtime.storage`.
- We must hold a reference to `targetId` at dialog-open time (not import time) to
  avoid the sprite switching mid-import (mirrors `handleCostumeUpload` in costume-tab).
- Tile extraction uses a single off-screen canvas, reused per tile, for efficiency.
- The dialog is appended to `document.body` and uses a backdrop overlay so it is
  properly modal. It is removed from the DOM on close.
- Dark-mode: use CSS custom properties (`--sa-spritesheet-*`) driven by
  `addon.tab.scratchClass`-based class presence, consistent with other dialog addons.
