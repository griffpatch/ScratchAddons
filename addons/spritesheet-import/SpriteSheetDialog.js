import SpriteSheetAnalyzer from "./SpriteSheetAnalyzer.js";
import SpriteSheetTileGrid from "./SpriteSheetTileGrid.js";

/** Zoom levels available via the + / − buttons. */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/** Persists the user's last chosen anchor across dialog opens. */
let _lastAnchorIndex = 4;

/**
 * SpriteSheetDialog — modal dialog for configuring and confirming a sprite sheet import.
 *
 * Usage:
 *   const dialog = new SpriteSheetDialog(addon, msg);
 *   const spec = await dialog.open(file); // null if cancelled
 *   if (spec) { ... import ... }
 */
export default class SpriteSheetDialog {
  /**
   * @param {object} addon - SA addon API object.
   * @param {Function} msg - SA i18n function.
   */
  constructor(addon, msg) {
    this._addon = addon;
    this._msg = msg;
    this._resolve = null; // Promise resolver
    this._tileGrid = null;
    this._analyzer = null;
    this._img = null;
    this._cols = 1;
    this._rows = 1;
    this._tileW = 16;
    this._tileH = 16;
    this._anchorIndex = _lastAnchorIndex;
    this._zoom = 1;
    this._midDrag = null;
    this._costumeNames = [];
  }

  /**
   * Open the dialog for the given image file.
   *
   * @param {File} file
   * @returns {Promise<ImportSpec | null>}
   *   Resolves with { tiles, cols, rows, baseName, anchorIndex, replaceExisting } or null on cancel.
   */
  /**
   * @param {string[]} [costumeNames] - Names of costumes already on the target sprite,
   *   used to highlight tiles that have already been imported.
   */
  open(file, costumeNames = []) {
    this._anchorIndex = _lastAnchorIndex;
    this._costumeNames = costumeNames;
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._buildDOM(file);
    });
  }

  // ─── DOM Construction ───────────────────────────────────────────────────────

  _buildDOM(file) {
    const { _msg: msg } = this;

    // Backdrop
    this._backdrop = Object.assign(document.createElement("div"), {
      className: "sa-ss-backdrop",
    });

    // Dialog container
    this._dialog = Object.assign(document.createElement("div"), {
      className: "sa-ss-dialog",
      role: "dialog",
      ariaModal: "true",
    });

    // Title
    const title = Object.assign(document.createElement("h2"), {
      className: "sa-ss-title",
      textContent: msg("dialog-title"),
    });

    // ── Left column: image preview ────────────────────────────────────────────
    const previewCol = Object.assign(document.createElement("div"), {
      className: "sa-ss-preview-col",
    });

    // Zoom bar
    const zoomBar = Object.assign(document.createElement("div"), {
      className: "sa-ss-zoom-bar",
    });
    this._zoomOutBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-zoom-btn",
      textContent: "−",
      title: "Zoom out",
    });
    this._zoomLabel = Object.assign(document.createElement("span"), {
      className: "sa-ss-zoom-label",
      textContent: "100%",
    });
    this._zoomInBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-zoom-btn",
      textContent: "+",
      title: "Zoom in",
    });
    this._zoomResetBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-zoom-btn",
      textContent: "⟳",
      title: "Reset zoom (100%)",
    });
    zoomBar.append(this._zoomOutBtn, this._zoomLabel, this._zoomInBtn, this._zoomResetBtn);

    // Preview area: scrollable wrap → inner div (inline-block at zoom size) → img + canvas
    this._previewWrap = Object.assign(document.createElement("div"), {
      className: "sa-ss-preview-wrap",
    });
    this._previewInner = Object.assign(document.createElement("div"), {
      className: "sa-ss-preview-inner",
    });
    this._previewImg = Object.assign(document.createElement("img"), {
      className: "sa-ss-preview-img",
      draggable: false,
    });
    this._overlayCanvas = Object.assign(document.createElement("canvas"), {
      className: "sa-ss-overlay",
    });
    this._previewInner.append(this._previewImg, this._overlayCanvas);
    this._previewWrap.append(this._previewInner);

    previewCol.append(zoomBar, this._previewWrap);

    // ── Right column: controls ────────────────────────────────────────────────
    const controlsCol = Object.assign(document.createElement("div"), {
      className: "sa-ss-controls-col",
    });

    // Tile size controls
    const gridControls = Object.assign(document.createElement("div"), {
      className: "sa-ss-grid-controls",
    });

    const tileWLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-spinner-label",
    });
    tileWLabel.append(
      Object.assign(document.createElement("span"), { textContent: msg("tile-width") })
    );
    this._tileWInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "2048",
      value: "16",
    });
    tileWLabel.append(this._tileWInput);

    const tileHLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-spinner-label",
    });
    tileHLabel.append(
      Object.assign(document.createElement("span"), { textContent: msg("tile-height") })
    );
    this._tileHInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "2048",
      value: "16",
    });
    tileHLabel.append(this._tileHInput);

    // Auto-detect button
    this._autoDetectBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("auto-detect"),
    });

    // Confidence message
    this._detectMsg = Object.assign(document.createElement("span"), {
      className: "sa-ss-detect-msg",
    });

    gridControls.append(tileWLabel, tileHLabel, this._autoDetectBtn, this._detectMsg);

    // Selection controls
    const selControls = Object.assign(document.createElement("div"), {
      className: "sa-ss-sel-controls",
    });

    this._selectAllBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("select-all"),
    });
    this._clearAllBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("clear-all"),
    });

    selControls.append(this._selectAllBtn, this._clearAllBtn);

    // Costume name
    const nameRow = Object.assign(document.createElement("div"), {
      className: "sa-ss-name-row",
    });
    const nameLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-name-label",
    });
    nameLabel.append(
      Object.assign(document.createElement("span"), { textContent: msg("name-label") })
    );
    this._nameInput = Object.assign(document.createElement("input"), {
      type: "text",
      className: "sa-ss-name-input",
    });
    nameLabel.append(this._nameInput);
    nameRow.append(nameLabel);

    // Replace previous import checkbox
    const replaceRow = Object.assign(document.createElement("label"), {
      className: "sa-ss-replace-row",
      title: "Removes all existing costumes whose name starts with '<name>:' before importing",
    });
    this._replaceCheckbox = Object.assign(document.createElement("input"), {
      type: "checkbox",
      className: "sa-ss-replace-checkbox",
    });
    replaceRow.append(
      this._replaceCheckbox,
      Object.assign(document.createElement("span"), { textContent: msg("replace-existing") })
    );

    // Anchor picker
    const anchorRow = Object.assign(document.createElement("div"), {
      className: "sa-ss-anchor-row",
    });
    anchorRow.append(
      Object.assign(document.createElement("span"), {
        className: "sa-ss-anchor-label",
        textContent: msg("anchor-label"),
      })
    );
    this._anchorGrid = Object.assign(document.createElement("div"), {
      className: "sa-ss-anchor-grid",
    });
    this._anchorBtns = Array.from({ length: 9 }, (_, i) => {
      const btn = Object.assign(document.createElement("button"), {
        className: "sa-ss-anchor-btn",
        title: this._anchorTitle(i),
      });
      btn.dataset.index = String(i);
      btn.addEventListener("click", () => this._setAnchor(i));
      return btn;
    });
    this._anchorGrid.append(...this._anchorBtns);
    anchorRow.append(this._anchorGrid);
    this._setAnchor(this._anchorIndex);

    controlsCol.append(gridControls, selControls, nameRow, replaceRow, anchorRow);

    // ── Body (two-column) ─────────────────────────────────────────────────────
    const body = Object.assign(document.createElement("div"), {
      className: "sa-ss-body",
    });
    body.append(previewCol, controlsCol);

    // Footer
    const footer = Object.assign(document.createElement("div"), {
      className: "sa-ss-footer",
    });
    this._cancelBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("cancel"),
    });
    this._importBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-primary",
    });
    footer.append(this._cancelBtn, this._importBtn);

    // Assemble
    this._dialog.append(title, body, footer);
    this._backdrop.append(this._dialog);
    document.body.append(this._backdrop);

    // Wire events
    this._cancelBtn.addEventListener("click", () => this._cancel());
    this._backdrop.addEventListener("click", (e) => {
      if (e.target === this._backdrop) this._cancel();
    });
    this._importBtn.addEventListener("click", () => this._confirm());
    this._autoDetectBtn.addEventListener("click", () => this._runAutoDetect());
    this._selectAllBtn.addEventListener("click", () => this._tileGrid?.selectAll());
    this._clearAllBtn.addEventListener("click", () => this._tileGrid?.clearAll());
    this._tileWInput.addEventListener("change", () => this._onGridInputChange());
    this._tileHInput.addEventListener("change", () => this._onGridInputChange());
    this._nameInput.addEventListener("input", () => this._updateImported());
    this._zoomInBtn.addEventListener("click", () => this._zoomIn());
    this._zoomOutBtn.addEventListener("click", () => this._zoomOut());
    this._zoomResetBtn.addEventListener("click", () => this._setZoom(1));

    // Middle-button pan on the preview wrap
    this._previewWrap.addEventListener("mousedown", (e) => this._onWrapMouseDown(e));
    this._previewWrap.addEventListener("mousemove", (e) => this._onWrapMouseMove(e));
    this._previewWrap.addEventListener("mouseup", (e) => this._onWrapMouseUp(e));
    this._previewWrap.addEventListener("mouseleave", () => this._onWrapMouseLeave());
    // Wheel-to-zoom (intercept before the browser can scroll the wrap).
    this._previewWrap.addEventListener("wheel", (e) => this._onWrapWheel(e), { passive: false });

    // Load image and initialize
    this._loadImage(file);
  }

  // ─── Image loading & initialization ────────────────────────────────────────

  _loadImage(file) {
    const url = URL.createObjectURL(file);
    this._nameInput.value = file.name.replace(/\.[^.]+$/, "");

    this._previewImg.onload = () => {
      URL.revokeObjectURL(url);
      this._img = this._previewImg;
      this._analyzer = new SpriteSheetAnalyzer(this._img);
      // Pick ×2 if the image fits in the available preview area, else ×1.
      // We defer one frame so the preview wrap has been laid out and its
      // clientWidth/clientHeight reflect the actual available space.
      requestAnimationFrame(() => {
        const w = this._previewWrap.clientWidth;
        const h = this._previewWrap.clientHeight;
        const naturalW = this._analyzer.imageWidth;
        const naturalH = this._analyzer.imageHeight;
        const zoom = naturalW * 2 <= w && naturalH * 2 <= h ? 2 : 1;
        this._setZoom(zoom);
        this._runAutoDetect();
      });
    };
    this._previewImg.src = url;
  }

  // ─── Auto-detect ────────────────────────────────────────────────────────────

  _runAutoDetect() {
    if (!this._analyzer) return;
    const candidates = this._analyzer.detectGrid();
    const best = candidates[0];
    this._applyGrid(best.cols, best.rows);
    this._detectMsg.textContent = this._msg(`auto-detect-${best.confidence}`);
    this._detectMsg.dataset.confidence = best.confidence;
  }

  // ─── Grid management ────────────────────────────────────────────────────────

  _onGridInputChange() {
    if (!this._analyzer) return;
    const tileW = Math.max(1, parseInt(this._tileWInput.value, 10) || 1);
    const tileH = Math.max(1, parseInt(this._tileHInput.value, 10) || 1);
    const cols = Math.max(1, Math.floor(this._analyzer.imageWidth / tileW));
    const rows = Math.max(1, Math.floor(this._analyzer.imageHeight / tileH));
    this._applyGrid(cols, rows);
    this._detectMsg.textContent = "";
  }

  /**
   * Re-compute blank tiles and rebuild the tile grid for the given dimensions.
   *
   * @param {number} cols
   * @param {number} rows
   */
  _applyGrid(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    if (this._analyzer) {
      this._tileW = Math.floor(this._analyzer.imageWidth / cols);
      this._tileH = Math.floor(this._analyzer.imageHeight / rows);
      this._tileWInput.value = String(this._tileW);
      this._tileHInput.value = String(this._tileH);
    }

    // Compute which tiles are blank (fully transparent).
    const blank = new Set();
    const selected = new Set();
    if (this._analyzer) {
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
          const key = `${c}:${r}`;
          const tileData = this._analyzer.getTileImageData(c, r, cols, rows);
          if (this._analyzer.isTileBlank(tileData)) {
            blank.add(key);
          } else {
            selected.add(key);
          }
        }
      }
    }

    const imported = this._computeImported(cols, rows);

    if (this._tileGrid) {
      this._tileGrid.setGrid(cols, rows, selected, blank, imported);
    } else {
      this._tileGrid = new SpriteSheetTileGrid(
        this._overlayCanvas,
        cols,
        rows,
        selected,
        blank,
        imported
      );
      this._tileGrid.onSelectionChange = () => this._updateImportButton();
    }

    this._updateImportButton();
  }

  // ─── Already-imported highlighting ──────────────────────────────────────────

  /**
   * Return the set of tile keys ("col:row") that already have a costume on the
   * sprite with the current base name.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Set<string>}
   */
  _computeImported(cols = this._cols, rows = this._rows) {
    const baseName = this._nameInput?.value.trim() || "costume";
    const nameSet = new Set(this._costumeNames);
    const imported = new Set();
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        if (nameSet.has(`${baseName}:${c}:${r}`)) imported.add(`${c}:${r}`);
      }
    }
    return imported;
  }

  /** Recompute the imported set after the base name changes and refresh the grid. */
  _updateImported() {
    if (!this._tileGrid) return;
    this._tileGrid.setImported(this._computeImported());
  }

  // ─── Anchor ─────────────────────────────────────────────────────────────────

  _setAnchor(index) {
    this._anchorIndex = index;
    _lastAnchorIndex = index;
    this._anchorBtns.forEach((btn, i) => {
      btn.classList.toggle("sa-ss-anchor-selected", i === index);
    });
  }

  _anchorTitle(index) {
    const labels = [
      "Top left", "Top center", "Top right",
      "Middle left", "Center", "Middle right",
      "Bottom left", "Bottom center", "Bottom right",
    ];
    return labels[index] ?? "";
  }

  // ─── Zoom ────────────────────────────────────────────────────────────────────

  /**
   * Set the zoom level and update the image/canvas CSS dimensions accordingly.
   * The overlay canvas buffer (in pixels) stays fixed at natural image size;
   * only its CSS display size changes, so _tileAt() (getBoundingClientRect) is
   * automatically correct at every zoom level.
   *
   * @param {number} factor
   */
  _setZoom(factor) {
    this._zoom = factor;
    if (!this._analyzer) return;
    const w = Math.round(this._analyzer.imageWidth * factor);
    const h = Math.round(this._analyzer.imageHeight * factor);
    // Resize the canvas buffer to the display size so 1 buffer pixel = 1 CSS pixel.
    // Grid lines stay exactly 1px and tile labels stay crisp at every zoom level.
    // The canvas CSS size is governed by `inset: 0` + the previewInner container.
    this._overlayCanvas.width = w;
    this._overlayCanvas.height = h;
    this._previewImg.style.width = `${w}px`;
    this._previewImg.style.height = `${h}px`;
    this._previewInner.style.width = `${w}px`;
    this._previewInner.style.height = `${h}px`;
    this._zoomLabel.textContent = `${Math.round(factor * 100)}%`;
    this._tileGrid?.render();
  }

  _zoomIn() {
    const i = ZOOM_STEPS.findIndex((s) => s > this._zoom);
    if (i !== -1) this._setZoom(ZOOM_STEPS[i]);
  }

  _zoomOut() {
    const i = [...ZOOM_STEPS].reverse().findIndex((s) => s < this._zoom);
    if (i !== -1) this._setZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1 - i]);
  }

  _onWrapWheel(e) {
    e.preventDefault();
    if (e.deltaY < 0) this._zoomIn();
    else this._zoomOut();
  }

  // ─── Middle-button pan ────────────────────────────────────────────────────────

  _onWrapMouseDown(e) {
    if (e.button !== 1) return;
    e.preventDefault(); // Prevent the browser's middle-click autoscroll indicator.
    this._midDrag = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: this._previewWrap.scrollLeft,
      scrollTop: this._previewWrap.scrollTop,
    };
    this._previewWrap.classList.add("sa-ss-panning");
  }

  _onWrapMouseMove(e) {
    if (!this._midDrag) return;
    e.preventDefault();
    this._previewWrap.scrollLeft = this._midDrag.scrollLeft - (e.clientX - this._midDrag.startX);
    this._previewWrap.scrollTop = this._midDrag.scrollTop - (e.clientY - this._midDrag.startY);
  }

  _onWrapMouseUp(e) {
    if (e.button !== 1 || !this._midDrag) return;
    this._midDrag = null;
    this._previewWrap.classList.remove("sa-ss-panning");
  }

  _onWrapMouseLeave() {
    if (this._midDrag) {
      this._midDrag = null;
      this._previewWrap.classList.remove("sa-ss-panning");
    }
  }

  // ─── Import button label ────────────────────────────────────────────────────

  _updateImportButton() {
    const count = this._tileGrid?.selectedCount ?? 0;
    this._importBtn.textContent =
      count > 0
        ? this._msg("import-button", { count })
        : this._msg("no-tiles");
    this._importBtn.disabled = count === 0;
  }

  // ─── Confirm / Cancel ────────────────────────────────────────────────────────

  _confirm() {
    if (!this._tileGrid || this._tileGrid.selectedCount === 0) return;

    // Convert selected set to sorted tile list (left-to-right, top-to-bottom).
    const selected = this._tileGrid.getSelectedSet();
    const tiles = [];
    for (let r = 1; r <= this._rows; r++) {
      for (let c = 1; c <= this._cols; c++) {
        if (selected.has(`${c}:${r}`)) {
          tiles.push({ col: c, row: r });
        }
      }
    }

    const spec = {
      tiles,
      cols: this._cols,
      rows: this._rows,
      baseName: this._nameInput.value.trim() || "costume",
      anchorIndex: this._anchorIndex,
      replaceExisting: this._replaceCheckbox.checked,
    };

    const resolve = this._resolve;
    this._close();
    resolve(spec);
  }

  _cancel() {
    const resolve = this._resolve;
    this._close();
    resolve(null);
  }

  _close() {
    this._backdrop.remove();
    this._tileGrid = null;
    this._analyzer = null;
    this._img = null;
    this._midDrag = null;
    this._resolve = null;
  }
}
