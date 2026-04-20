/**
 * SpriteSheetTileGrid — canvas overlay for tile selection.
 *
 * Renders a grid over the image preview, handles click and drag-rectangle
 * selection. Tile indices are 1-based (col, row).
 */
export default class SpriteSheetTileGrid {
  /**
   * @param {HTMLCanvasElement} canvas - Overlay canvas (sized to match the preview image).
   * @param {number} cols
   * @param {number} rows
   * @param {Set<string>} selected - Initial selected set, keys are `"col:row"`.
   * @param {Set<string>} blank - Set of tile keys that are fully transparent and unselectable.
   */
  constructor(canvas, cols, rows, selected = new Set(), blank = new Set(), imported = new Set()) {
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
    this._cols = cols;
    this._rows = rows;
    this._selected = new Set(selected);
    this._blank = new Set(blank);
    this._imported = new Set(imported);

    /** Called with no args whenever selection changes. */
    this.onSelectionChange = null;

    // Drag state: null when not dragging.
    this._drag = null; // { baseline: Set, startCol, startRow, targetState }
    this._notifyPending = false;

    this._canvas.addEventListener("mousedown", this._onMouseDown.bind(this));
    this._canvas.addEventListener("mousemove", this._onMouseMove.bind(this));
    this._canvas.addEventListener("mouseup", this._onMouseUp.bind(this));
    this._canvas.addEventListener("mouseleave", this._onMouseLeave.bind(this));

    this.render();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Update the grid dimensions and re-render. Selected and blank sets are reset. */
  setGrid(cols, rows, selected = new Set(), blank = new Set(), imported = new Set()) {
    this._cols = cols;
    this._rows = rows;
    this._selected = new Set(selected);
    this._blank = new Set(blank);
    this._imported = new Set(imported);
    this.render();
  }

  /** Update only the imported-tile set and re-render (preserves selection). */
  setImported(imported = new Set()) {
    this._imported = new Set(imported);
    this.render();
  }

  selectAll() {
    this._selected.clear();
    for (let r = 1; r <= this._rows; r++) {
      for (let c = 1; c <= this._cols; c++) {
        // Blank tiles cannot be selected.
        if (!this._blank.has(`${c}:${r}`)) {
          this._selected.add(`${c}:${r}`);
        }
      }
    }
    this.render();
    this._notifyChange();
  }

  clearAll() {
    this._selected.clear();
    this.render();
    this._notifyChange();
  }

  /** @returns {Set<string>} Copy of the current selected set. */
  getSelectedSet() {
    return new Set(this._selected);
  }

  get selectedCount() {
    return this._selected.size;
  }

  /** Total non-blank (importable) tile count. */
  get totalCount() {
    return this._cols * this._rows - this._blank.size;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  render() {
    const { _canvas: canvas, _ctx: ctx, _cols: cols, _rows: rows } = this;
    // Read the CSS display size. _setZoom sets canvas.style.width/height explicitly so
    // this is always in sync. If somehow not set, fall back to the buffer dimension (dpr = 1).
    const cssW = parseFloat(canvas.style.width) || canvas.width;
    const cssH = parseFloat(canvas.style.height) || canvas.height;
    // Apply the DPR scale so all drawing coordinates are in logical CSS pixels, which keeps
    // stroke widths, badge sizes, and hatch spacing consistent regardless of screen density.
    const dpr = canvas.width / cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const tileW = cssW / cols;
    const tileH = cssH / rows;

    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const x = (c - 1) * tileW;
        const y = (r - 1) * tileH;
        const key = `${c}:${r}`;
        if (this._blank.has(key)) {
          this._renderBlankTile(ctx, x, y, tileW, tileH);
        } else {
          this._renderContentTile(ctx, x, y, tileW, tileH, this._selected.has(key), this._imported.has(key));
        }
      }
    }
  }

  /** Draw a hatched overlay for a blank (fully-transparent) tile. */
  _renderBlankTile(ctx, x, y, w, h) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
    ctx.fillRect(x, y, w, h);

    // Diagonal hatching to indicate "empty / not importable".
    const spacing = Math.max(6, Math.min(w, h) / 4);
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(140, 140, 140, 0.35)";
    ctx.lineWidth = 1;
    for (let d = -h; d < w + h; d += spacing) {
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d + h, y + h);
    }
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = "rgba(180, 180, 180, 0.25)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /**
   * Draw a content tile. Two independent state channels:
   *   - Selected: blue tint + blue border + tick-in-circle badge at center.
   *   - Imported: small green circle badge in top-right corner.
   * Both badges can coexist so both states are always legible simultaneously.
   */
  _renderContentTile(ctx, x, y, w, h, isSelected, isImported) {
    // Fill — minimal dark overlay when unselected so the image shows through;
    // blue tint when selected so the selection region is clearly visible.
    ctx.fillStyle = isSelected ? "rgba(30, 100, 255, 0.22)" : "rgba(0, 0, 0, 0.10)";
    ctx.fillRect(x, y, w, h);

    // Border — blue when selected, faint grey otherwise.
    ctx.strokeStyle = isSelected ? "rgba(60, 130, 255, 0.9)" : "rgba(180, 180, 180, 0.5)";
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    const s = Math.min(w, h);

    // ── Selected badge: filled circle with a white tick at the tile center ──
    if (isSelected && s >= 10) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = s * 0.20;

      // Circle background
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(40, 120, 255, 0.9)";
      ctx.fill();

      // Tick inside the circle
      const arm = r * 0.58;
      ctx.save();
      ctx.strokeStyle = "white";
      ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - arm * 0.62, cy + arm * 0.05);
      ctx.lineTo(cx - arm * 0.05, cy + arm * 0.72);
      ctx.lineTo(cx + arm * 0.78, cy - arm * 0.62);
      ctx.stroke();
      ctx.restore();
    }

    // ── Imported badge: small green circle in the top-right corner ──
    if (isImported && s >= 8) {
      const dotR = Math.max(2, s * 0.14);
      const margin = dotR + 1.5;
      ctx.beginPath();
      ctx.arc(x + w - margin, y + margin, dotR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 200, 85, 0.95)";
      ctx.fill();
    }
  }

  // ─── Mouse handling ─────────────────────────────────────────────────────────

  /** Convert client coordinates to 1-based {col, row}. */
  _tileAt(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const scaleX = this._canvas.width / rect.width;
    const scaleY = this._canvas.height / rect.height;
    const px = (clientX - rect.left) * scaleX;
    const py = (clientY - rect.top) * scaleY;
    const tileW = this._canvas.width / this._cols;
    const tileH = this._canvas.height / this._rows;
    return {
      col: Math.max(1, Math.min(this._cols, Math.floor(px / tileW) + 1)),
      row: Math.max(1, Math.min(this._rows, Math.floor(py / tileH) + 1)),
    };
  }

  _onMouseDown(e) {
    // Only handle left-button clicks; middle-button is reserved for pan.
    if (e.button !== 0) return;
    e.preventDefault();
    const { col, row } = this._tileAt(e.clientX, e.clientY);
    // Blank tiles cannot be toggled.
    if (this._blank.has(`${col}:${row}`)) return;
    // Target state = opposite of the clicked tile's current state.
    const targetState = !this._selected.has(`${col}:${row}`);
    // Snapshot current selection as baseline for the drag.
    this._drag = {
      baseline: new Set(this._selected),
      startCol: col,
      startRow: row,
      targetState,
    };
    this._applyDragRect(col, row);
    this.render();
    this._notifyChange();
  }

  _onMouseMove(e) {
    if (!this._drag) return;
    e.preventDefault();
    const { col, row } = this._tileAt(e.clientX, e.clientY);
    // Restore baseline then re-apply rectangle to current cursor position.
    this._selected = new Set(this._drag.baseline);
    this._applyDragRect(col, row);
    this.render();
    this._notifyChange();
  }

  _onMouseUp(_e) {
    this._drag = null;
  }

  _onMouseLeave(_e) {
    this._drag = null;
  }

  /** Apply the drag rectangle from drag start to (currentCol, currentRow). */
  _applyDragRect(currentCol, currentRow) {
    const { startCol, startRow, targetState } = this._drag;
    const minC = Math.min(startCol, currentCol);
    const maxC = Math.max(startCol, currentCol);
    const minR = Math.min(startRow, currentRow);
    const maxR = Math.max(startRow, currentRow);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        // Blank tiles are never selectable.
        if (this._blank.has(`${c}:${r}`)) continue;
        if (targetState) {
          this._selected.add(`${c}:${r}`);
        } else {
          this._selected.delete(`${c}:${r}`);
        }
      }
    }
  }

  _notifyChange() {
    if (this._notifyPending) return;
    this._notifyPending = true;
    queueMicrotask(() => {
      this._notifyPending = false;
      this.onSelectionChange?.();
    });
  }
}
