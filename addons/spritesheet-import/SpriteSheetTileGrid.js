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
   */
  constructor(canvas, cols, rows, selected = new Set()) {
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
    this._cols = cols;
    this._rows = rows;
    this._selected = new Set(selected);

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

  /** Update the grid dimensions and re-render. Selected set is reset. */
  setGrid(cols, rows, selected = new Set()) {
    this._cols = cols;
    this._rows = rows;
    this._selected = new Set(selected);
    this.render();
  }

  selectAll() {
    this._selected.clear();
    for (let r = 1; r <= this._rows; r++) {
      for (let c = 1; c <= this._cols; c++) {
        this._selected.add(`${c}:${r}`);
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

  // ─── Rendering ─────────────────────────────────────────────────────────────

  render() {
    const { _canvas: canvas, _ctx: ctx, _cols: cols, _rows: rows } = this;
    const w = canvas.width;
    const h = canvas.height;
    const tileW = w / cols;
    const tileH = h / rows;

    ctx.clearRect(0, 0, w, h);

    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const x = (c - 1) * tileW;
        const y = (r - 1) * tileH;
        const key = `${c}:${r}`;
        const isSelected = this._selected.has(key);

        // Tile fill — semi-transparent overlay
        ctx.fillStyle = isSelected
          ? "rgba(0, 100, 255, 0.25)"
          : "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(x, y, tileW, tileH);

        // Tile border
        ctx.strokeStyle = isSelected
          ? "rgba(0, 100, 255, 0.9)"
          : "rgba(180, 180, 180, 0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, tileW - 1, tileH - 1);

        // Small checkmark for selected tiles (if large enough to be legible)
        if (isSelected && tileW >= 16 && tileH >= 16) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.font = `${Math.min(tileW, tileH) * 0.45}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("✓", x + tileW / 2, y + tileH / 2);
        }
      }
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
    e.preventDefault();
    const { col, row } = this._tileAt(e.clientX, e.clientY);
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
