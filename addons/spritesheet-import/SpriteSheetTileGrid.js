/**
 * SpriteSheetTileGrid — canvas overlay for tile selection.
 *
 * The canvas is viewport-sized (matching the scroll container's visible area)
 * rather than image-sized. render() reads the container's scrollLeft/scrollTop
 * and offsets all drawing so the correct region of the tile grid is always
 * visible regardless of zoom level or image size.
 *
 * Tile indices are 1-based (col, row).
 */
export default class SpriteSheetTileGrid {
  /**
   * @param {HTMLCanvasElement} canvas - Viewport-sized overlay canvas.
   * @param {Element} scrollContainer - The scrollable preview wrapper element.
   * @param {number} cols
   * @param {number} rows
   * @param {Set<string>} selected - Initial selected set, keys are `"col:row"`.
   * @param {Set<string>} blank - Set of tile keys that are fully transparent and unselectable.
   */
  constructor(canvas, scrollContainer, cols, rows, selected = new Set(), blank = new Set(), imported = new Set()) {
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
    this._container = scrollContainer;
    this._cols = cols;
    this._rows = rows;
    this._selected = new Set(selected);
    this._blank = new Set(blank);
    this._imported = new Set(imported);
    /** Full image display size in CSS px (zoom × natural size). Updated by setImageDimensions(). */
    this._imgCssW = 1;
    this._imgCssH = 1;

    /** Called with no args whenever selection changes. */
    this.onSelectionChange = null;

    /**
     * When true, draw a small × at the anchor point on every non-blank tile.
     * Set anchorPoint to { x, y } in tile-local pixels before enabling.
     */
    this.showAnchor = false;
    /** Anchor point in tile-local natural image pixels (fractional). */
    this.anchorPoint = { x: 0, y: 0 };
    /** Natural (unzoomed) tile dimensions — set by the dialog after grid detection. */
    this.naturalTileW = 1;
    this.naturalTileH = 1;
    /** Symmetric padding inset in natural image pixels — used to draw the content-box rect. */
    this.tilePadding = { left: 0, top: 0, right: 0, bottom: 0 };

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

  /**
   * Set the full zoomed image CSS dimensions and re-render.
   * Must be called whenever zoom changes so tile positions are correct.
   *
   * @param {number} w - imageWidth × zoom in CSS px
   * @param {number} h - imageHeight × zoom in CSS px
   */
  setImageDimensions(w, h) {
    this._imgCssW = w;
    this._imgCssH = h;
    this.render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  render() {
    const { _canvas: canvas, _ctx: ctx, _cols: cols, _rows: rows } = this;
    // Canvas CSS dimensions = visible viewport of the scroll container.
    const cssW = parseFloat(canvas.style.width) || canvas.clientWidth || canvas.width;
    const cssH = parseFloat(canvas.style.height) || canvas.clientHeight || canvas.height;
    if (!cssW || !cssH) return;
    // DPR scale: buffer pixels per CSS pixel (canvas.width set by dialog on resize).
    const dpr = canvas.width / cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Tile size in the zoomed image coordinate space.
    const tileW = this._imgCssW / cols;
    const tileH = this._imgCssH / rows;
    // Scroll offset: how much of the image is scrolled out of view to the top-left.
    const scrollX = this._container.scrollLeft;
    const scrollY = this._container.scrollTop;

    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        // Tile position in canvas coords = image-space origin minus scroll offset.
        const x = (c - 1) * tileW - scrollX;
        const y = (r - 1) * tileH - scrollY;
        // Cull tiles fully outside the viewport canvas.
        if (x + tileW < 0 || x > cssW || y + tileH < 0 || y > cssH) continue;
        const key = `${c}:${r}`;
        if (this._blank.has(key)) this._renderBlankTile(ctx, x, y, tileW, tileH);
        else this._renderContentTile(ctx, x, y, tileW, tileH, this._selected.has(key), this._imported.has(key));
      }
    }

    // Padding boxes are always drawn when padding is applied — independent of showAnchor.
    const { left: pl, top: pt, right: pr, bottom: pb } = this.tilePadding;
    if (pl || pt || pr || pb) this._renderPaddingBoxes(ctx, cols, rows, tileW, tileH, scrollX, scrollY);

    // Anchor circle: only at 200%+ zoom so it doesn't clutter smaller views.
    const zoom = this.naturalTileW ? tileW / this.naturalTileW : 1;
    if (this.showAnchor && zoom >= 2) this._renderAnchorPoints(ctx, cols, rows, tileW, tileH, scrollX, scrollY);
  }

  /** Call fn(x, y) for the top-left corner of every non-blank tile visible in the viewport. */
  _forTiles(cols, rows, tileW, tileH, scrollX, scrollY, fn) {
    const cssW = parseFloat(this._canvas.style.width) || this._canvas.clientWidth;
    const cssH = parseFloat(this._canvas.style.height) || this._canvas.clientHeight;
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        if (this._blank.has(`${c}:${r}`)) continue;
        const x = (c - 1) * tileW - scrollX;
        const y = (r - 1) * tileH - scrollY;
        if (x + tileW < 0 || x > cssW || y + tileH < 0 || y > cssH) continue;
        fn(x, y);
      }
    }
  }

  /** Hatched dark overlay for fully-transparent (unselectable) tiles. */
  _renderBlankTile(ctx, x, y, w, h) {
    ctx.fillStyle = "rgba(0,0,0,0.06)"; ctx.fillRect(x, y, w, h);
    // Diagonal hatching to indicate "empty / not importable".
    const sp = Math.max(6, Math.min(w, h) / 4);
    ctx.save();
    ctx.strokeStyle = "rgba(140,140,140,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -h; d < w + h; d += sp) { ctx.moveTo(x + d, y); ctx.lineTo(x + d + h, y + h); }
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = "rgba(180,180,180,0.25)"; ctx.lineWidth = 0.5;
    ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  }

  /**
   * Draw a content tile with two independent state channels:
   *   - Selected: blue tint + border + tick badge in top-left corner.
   *   - Imported: small green dot badge in top-right corner.
   * Badges are fixed CSS-pixel size so they don't scale with zoom.
   */
  _renderContentTile(ctx, x, y, w, h, sel, imp) {
    // Tint + border vary by selection state.
    ctx.fillStyle = sel ? "rgba(30,100,255,0.22)" : "rgba(0,0,0,0.10)"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = sel ? "rgba(60,130,255,0.9)" : "rgba(180,180,180,0.5)";
    ctx.lineWidth = sel ? 1.5 : 1; ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);

    // Tick badge: blue circle with white checkmark, top-left corner.
    // R and margin both scale with tile size (floor(minDim/9), min 7) so the
    // badge stays modest at 200% and grows naturally as the user zooms in.
    if (sel && w >= 20 && h >= 20) {
      const R = Math.max(7, Math.floor(Math.min(w, h) / 9));
      const m = Math.max(2, Math.floor(R / 4));
      const cx = x + m + R, cy = y + m + R, a = R * 0.58;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(40,120,255,0.9)"; ctx.fill();
      ctx.save();
      ctx.strokeStyle = "white"; ctx.lineWidth = Math.max(1.5, R / 5); ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - a * .62, cy + a * .05); ctx.lineTo(cx - a * .05, cy + a * .72); ctx.lineTo(cx + a * .78, cy - a * .62);
      ctx.stroke(); ctx.restore();
    }

    // Imported badge: green dot, top-right corner.
    // Scales with tile size (floor(minDim/10), min 4) — larger than the tick
    // divisor so it stays proportionate and clearly visible at all zoom levels.
    if (imp && w >= 8 && h >= 8) {
      const r = Math.max(4, Math.floor(Math.min(w, h) / 10));
      const dm = Math.max(2, Math.floor(r / 2));
      ctx.beginPath(); ctx.arc(x + w - r - dm, y + r + dm, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,200,85,0.95)"; ctx.fill();
    }
  }

  /**
   * Dashed content-box rect showing the transparent padding inset on every non-blank tile.
   * Uses a two-pass technique (dark outline then white dashed stroke) so it remains
   * legible against any sprite background colour.
   * All sizes are in fixed CSS pixels so they don't scale with zoom.
   */
  _renderPaddingBoxes(ctx, cols, rows, tileW, tileH, scrollX, scrollY) {
    const { left: pl, top: pt, right: pr, bottom: pb } = this.tilePadding;
    const lx = (pl / this.naturalTileW) * tileW, ty = (pt / this.naturalTileH) * tileH;
    const bw = tileW - lx - (pr / this.naturalTileW) * tileW;
    const bh = tileH - ty - (pb / this.naturalTileH) * tileH;
    for (const [color, lw, dash] of [["rgba(0,0,0,0.5)", 3, []], ["rgba(255,255,255,0.9)", 1, [4, 3]]]) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash);
      this._forTiles(cols, rows, tileW, tileH, scrollX, scrollY,
        (x, y) => ctx.strokeRect(x + lx + .5, y + ty + .5, bw - 1, bh - 1));
      ctx.restore();
    }
  }

  /**
   * Draw a small circle at the anchor point on every non-blank tile.
   * Only called at 200%+ zoom (see render()). Uses a two-pass technique
   * (dark outline then yellow fill) so it remains legible against any background.
   */
  _renderAnchorPoints(ctx, cols, rows, tileW, tileH, scrollX, scrollY) {
    const ax = (this.anchorPoint.x / this.naturalTileW) * tileW;
    const ay = (this.anchorPoint.y / this.naturalTileH) * tileH;
    const R = 5;
    for (const [color, lw] of [["rgba(0,0,0,0.6)", 3.5], ["rgba(255,220,0,1)", 1.5]]) {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      this._forTiles(cols, rows, tileW, tileH, scrollX, scrollY, (x, y) => {
        ctx.beginPath(); ctx.arc(x + ax, y + ay, R, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.restore();
    }
  }

  /**
   * Convert client coordinates to 1-based {col, row}, or null if the click
   * landed outside the image bounds (e.g. on empty wrap area past the edge).
   *
   * The canvas is sticky at (0,0) of the scroll container's viewport, so
   * getBoundingClientRect() gives the top-left of the visible area. Adding
   * the scroll offset converts to image-space coordinates.
   *
   * @returns {{col:number, row:number}|null}
   */
  _tileAt(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    // Position within the visible viewport (canvas is sticky at its top-left).
    const vpX = clientX - rect.left;
    const vpY = clientY - rect.top;
    // Add scroll offset to reach image-space coordinates.
    const imgX = vpX + this._container.scrollLeft;
    const imgY = vpY + this._container.scrollTop;
    // Reject clicks outside the actual image area.
    if (imgX < 0 || imgX > this._imgCssW || imgY < 0 || imgY > this._imgCssH) return null;
    const tileW = this._imgCssW / this._cols;
    const tileH = this._imgCssH / this._rows;
    return {
      col: Math.max(1, Math.min(this._cols, Math.floor(imgX / tileW) + 1)),
      row: Math.max(1, Math.min(this._rows, Math.floor(imgY / tileH) + 1)),
    };
  }

  _onMouseDown(e) {
    // Only handle left-button clicks; middle-button is reserved for pan.
    if (e.button !== 0) return;
    e.preventDefault();
    const tile = this._tileAt(e.clientX, e.clientY);
    // Ignore clicks outside the image area or on blank tiles.
    if (!tile) return;
    const { col, row } = tile;
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
    const tile = this._tileAt(e.clientX, e.clientY);
    if (!tile) return;
    const { col, row } = tile;
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
