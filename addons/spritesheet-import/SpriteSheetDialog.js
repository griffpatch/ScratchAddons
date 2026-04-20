import SpriteSheetAnalyzer from "./SpriteSheetAnalyzer.js";
import SpriteSheetImporter from "./SpriteSheetImporter.js";
import SpriteSheetTileGrid from "./SpriteSheetTileGrid.js";

/** Zoom levels available via the + / − buttons. */
const ZOOM_STEPS = [2, 3, 4, 6, 8, 12, 16];

/** Persists the user's last chosen anchor across dialog opens. */
let _lastAnchorIndex = 4;

/** Persists the keep-open preference across dialog opens. */
let _lastKeepOpen = false;

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
    this._padding = 0;
    this._showAnchor = false;
    this._zoom = 1;
    this._midDrag = null;
    /** @type {Set<number> | null} djb2 hashes of existing costume pixel data; null while decoding. */
    this._costumeHashes = null;
  }

  /**
   * Open the dialog for the given image file.
   *
   * @param {File} file
   * @returns {Promise<ImportSpec | null>}
   *   Resolves with { tiles, cols, rows, baseName, anchorIndex, replaceExisting } or null on cancel.
   */
  /**
   * @param {File} file
   * @param {object[]} [existingCostumes] - VM costume objects already on the target sprite.
   *   Used to highlight tiles whose pixel content is already imported.
   */
  open(file, existingCostumes = []) {
    this._anchorIndex = _lastAnchorIndex;
    this._costumeHashes = null;
    // Decode existing costumes to pixel hashes eagerly so the grid can be
    // highlighted as soon as decoding finishes (usually before the user is done
    // configuring the grid).
    this._decodeCostumes(existingCostumes).then(() => this._updateImported());
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
      title: "Reset zoom (200%)",
    });
    // Divider between zoom and selection controls
    const zoomDivider = Object.assign(document.createElement("span"), {
      className: "sa-ss-toolbar-divider",
    });
    this._selectAllBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-zoom-btn",
      textContent: msg("select-all"),
    });
    this._clearAllBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-zoom-btn",
      textContent: msg("clear-all"),
    });
    this._selectionCounter = Object.assign(document.createElement("span"), {
      className: "sa-ss-selection-count",
      textContent: "0 / 0",
    });
    zoomBar.append(
      this._zoomOutBtn, this._zoomLabel, this._zoomInBtn, this._zoomResetBtn,
      zoomDivider,
      this._selectAllBtn, this._clearAllBtn, this._selectionCounter,
    );

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

    // Tile size controls: W and H side-by-side, label above each input
    const tileSizeSection = Object.assign(document.createElement("div"), {
      className: "sa-ss-tile-size-section",
    });
    const tileWHRow = Object.assign(document.createElement("div"), {
      className: "sa-ss-tile-wh-row",
    });
    const tileWField = Object.assign(document.createElement("label"), {
      className: "sa-ss-tile-field",
    });
    tileWField.append(
      Object.assign(document.createElement("span"), { textContent: msg("tile-width") })
    );
    this._tileWInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "2048",
      value: "16",
    });
    tileWField.append(this._tileWInput);
    const tileHField = Object.assign(document.createElement("label"), {
      className: "sa-ss-tile-field",
    });
    tileHField.append(
      Object.assign(document.createElement("span"), { textContent: msg("tile-height") })
    );
    this._tileHInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "2048",
      value: "16",
    });
    tileHField.append(this._tileHInput);
    tileWHRow.append(tileWField, tileHField);

    this._autoDetectBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary sa-ss-full-width-btn",
      textContent: msg("auto-detect"),
    });
    this._detectMsg = Object.assign(document.createElement("span"), {
      className: "sa-ss-detect-msg",
    });
    tileSizeSection.append(tileWHRow, this._autoDetectBtn, this._detectMsg);

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
    const anchorHeader = Object.assign(document.createElement("div"), {
      className: "sa-ss-anchor-header",
    });
    this._showAnchorBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-anchor-toggle",
      textContent: msg("show-anchors"),
      title: msg("show-anchors-title"),
      type: "button",
    });
    anchorHeader.append(
      Object.assign(document.createElement("span"), {
        className: "sa-ss-anchor-label",
        textContent: msg("anchor-label"),
      }),
      this._showAnchorBtn,
    );
    anchorRow.append(anchorHeader);
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

    // Padding — shown inside the anchor section because it directly offsets the anchor point.
    const anchorPaddingRow = Object.assign(document.createElement("div"), {
      className: "sa-ss-anchor-padding-row",
    });
    this._paddingInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner sa-ss-anchor-padding-input",
      min: "0",
      max: "256",
      value: String(this._padding),
      title: msg("padding-title"),
    });
    this._detectPaddingBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("detect-padding"),
      title: msg("detect-padding-title"),
    });
    anchorPaddingRow.append(
      Object.assign(document.createElement("span"), {
        className: "sa-ss-anchor-label",
        textContent: msg("padding-label"),
      }),
      this._paddingInput,
      this._detectPaddingBtn,
    );

    anchorRow.append(this._anchorGrid, anchorPaddingRow);
    this._setAnchor(this._anchorIndex);

    controlsCol.append(tileSizeSection, nameRow, replaceRow, anchorRow);

    // ── Body (two-column) ─────────────────────────────────────────────────────
    const body = Object.assign(document.createElement("div"), {
      className: "sa-ss-body",
    });
    body.append(previewCol, controlsCol);

    // Footer
    const footer = Object.assign(document.createElement("div"), {
      className: "sa-ss-footer",
    });
    // Keep-open checkbox — left side of footer
    const keepOpenLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-keep-open-label",
    });
    this._keepOpenCheckbox = Object.assign(document.createElement("input"), {
      type: "checkbox",
      className: "sa-ss-keep-open-checkbox",
    });
    this._keepOpenCheckbox.checked = _lastKeepOpen;
    this._keepOpenCheckbox.addEventListener("change", () => {
      _lastKeepOpen = this._keepOpenCheckbox.checked;
      this._updateCancelLabel();
    });
    keepOpenLabel.append(
      this._keepOpenCheckbox,
      Object.assign(document.createElement("span"), { textContent: msg("keep-open") })
    );
    this._cancelBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("cancel"),
    });
    this._importBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-primary",
    });
    footer.append(keepOpenLabel, this._cancelBtn, this._importBtn);

    // Assemble
    this._dialog.append(title, body, footer);
    this._backdrop.append(this._dialog);
    document.body.append(this._backdrop);

    // Initialise Cancel/Close label to match persisted keep-open state.
    this._updateCancelLabel();

    // Wire events
    this._cancelBtn.addEventListener("click", () => this._cancel());
    this._backdrop.addEventListener("click", (e) => {
      if (e.target === this._backdrop) this._cancel();
    });
    this._importBtn.addEventListener("click", () => void this._confirm());
    this._autoDetectBtn.addEventListener("click", () => this._runAutoDetect());
    this._selectAllBtn.addEventListener("click", () => this._tileGrid?.selectAll());
    this._clearAllBtn.addEventListener("click", () => this._tileGrid?.clearAll());
    this._tileWInput.addEventListener("change", () => this._onGridInputChange());
    this._tileHInput.addEventListener("change", () => this._onGridInputChange());
    this._paddingInput.addEventListener("change", () => {
      this._padding = Math.max(0, parseInt(this._paddingInput.value, 10) || 0);
      this._paddingInput.value = String(this._padding);
      this._updateAnchorOverlay();
    });
    this._detectPaddingBtn.addEventListener("click", () => this._runDetectPadding());
    this._showAnchorBtn.addEventListener("click", () => {
      this._showAnchor = !this._showAnchor;
      this._showAnchorBtn.classList.toggle("sa-ss-anchor-toggle-active", this._showAnchor);
      this._updateAnchorOverlay();
    });
    this._replaceCheckbox.addEventListener("change", () => this._updateImportButton());
    this._zoomInBtn.addEventListener("click", () => this._zoomIn());
    this._zoomOutBtn.addEventListener("click", () => this._zoomOut());
    this._zoomResetBtn.addEventListener("click", () => this._setZoom(2));

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
        // Minimum zoom is ×2; go to ×4 if it fits, otherwise ×2.
        const zoom = naturalW * 4 <= w && naturalH * 4 <= h ? 4 : 2;
        this._setZoom(zoom);
        this._runAutoDetect();
        this._runDetectPadding();
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

  _runDetectPadding() {
    if (!this._analyzer) return;
    const p = this._analyzer.detectPadding(this._cols, this._rows);
    // Use the minimum of the four sides as a single symmetric padding value,
    // since the anchor grid only supports one uniform inset.
    const uniform = Math.min(p.left, p.top, p.right, p.bottom);
    this._padding = uniform;
    this._paddingInput.value = String(uniform);
    this._updateAnchorOverlay();
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
    this._updateAnchorOverlay();
  }

  // ─── Already-imported highlighting ──────────────────────────────────────────

  /**
   * Decode each existing costume's PNG to raw pixels and compute a djb2 hash.
   * Stored in `_costumeHashes` so `_computeImported` can do synchronous lookups.
   * Non-decodable costumes (SVGs with rendering issues, etc.) are silently skipped.
   *
   * @param {object[]} costumes - VM costume objects.
   */
  async _decodeCostumes(costumes) {
    const hashes = new Set();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    for (const costume of costumes) {
      const bytes = costume.asset?.data;
      if (!bytes) continue;
      try {
        const mime = costume.dataFormat === "svg" ? "image/svg+xml" : "image/png";
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        // Read dimensions BEFORE close()
        const bw = bitmap.width, bh = bitmap.height;
        // Scratch stores bitmap costumes at bitmapResolution× (typically 2×) for HiDPI.
        // Normalise back to logical pixels so the hash matches the tile ImageData.
        const res = costume.bitmapResolution ?? 1;
        const compareW = Math.round(bw / res);
        const compareH = Math.round(bh / res);
        canvas.width = compareW;
        canvas.height = compareH;
        ctx.clearRect(0, 0, compareW, compareH);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, 0, 0, bw, bh, 0, 0, compareW, compareH);
        bitmap.close();
        const imageData = ctx.getImageData(0, 0, compareW, compareH);
        hashes.add(SpriteSheetAnalyzer.hashImageData(imageData));
      } catch {
        // skip undecoded costumes silently
      }
    }

    this._costumeHashes = hashes;
  }

  /**
   * Return the set of tile keys ("col:row") whose pixel content exactly matches
   * a costume already on the sprite (by djb2 hash of raw RGBA pixel data).
   * Returns an empty set if costume decoding has not finished yet.
   *
   * @param {number} [cols]
   * @param {number} [rows]
   * @returns {Set<string>}
   */
  _computeImported(cols = this._cols, rows = this._rows) {
    if (!this._costumeHashes || !this._analyzer) return new Set();
    const imported = new Set();
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const tileData = this._analyzer.getTileImageData(c, r, cols, rows);
        const h = SpriteSheetAnalyzer.hashImageData(tileData);
        if (this._costumeHashes.has(h)) imported.add(`${c}:${r}`);
      }
    }
    return imported;
  }

  /** Recompute the imported set and refresh the grid overlay. */
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
    this._updateAnchorOverlay();
  }

  /**
   * Push the current anchor position and padding to the tile grid overlay.
   * Called whenever anchorIndex, padding, or grid dimensions change.
   */
  _updateAnchorOverlay() {
    if (!this._tileGrid) return;
    const padding = { left: this._padding, top: this._padding, right: this._padding, bottom: this._padding };
    this._tileGrid.naturalTileW = this._tileW;
    this._tileGrid.naturalTileH = this._tileH;
    this._tileGrid.anchorPoint = SpriteSheetImporter.anchorToCenter(this._anchorIndex, this._tileW, this._tileH, padding);
    this._tileGrid.tilePadding = padding;
    this._tileGrid.showAnchor = this._showAnchor;
    this._tileGrid.render();
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
    const dpr = devicePixelRatio ?? 1;
    // Size the canvas buffer at physical-pixel resolution for crisp rendering on HiDPI screens.
    // The explicit CSS size keeps the canvas at w × h logical pixels; the DPR scale is transparent
    // to all drawing code (render() applies ctx.setTransform to account for it).
    this._overlayCanvas.width = Math.round(w * dpr);
    this._overlayCanvas.height = Math.round(h * dpr);
    this._overlayCanvas.style.width = `${w}px`;
    this._overlayCanvas.style.height = `${h}px`;
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
    const wrap = this._previewWrap;
    // Capture the cursor position relative to the content before zooming.
    const mouseX = e.clientX - wrap.getBoundingClientRect().left;
    const mouseY = e.clientY - wrap.getBoundingClientRect().top;
    const contentX = (wrap.scrollLeft + mouseX) / this._zoom;
    const contentY = (wrap.scrollTop + mouseY) / this._zoom;

    if (e.deltaY < 0) this._zoomIn();
    else this._zoomOut();

    // After zoom, scroll so the point under the cursor stays fixed.
    wrap.scrollLeft = contentX * this._zoom - mouseX;
    wrap.scrollTop = contentY * this._zoom - mouseY;
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
    const total = this._tileGrid?.totalCount ?? 0;
    const replacing = this._replaceCheckbox?.checked ?? false;
    if (replacing) {
      this._importBtn.textContent =
        count > 0
          ? this._msg("replace-button", { count })
          : this._msg("remove-all");
      this._importBtn.disabled = false;
    } else {
      this._importBtn.textContent =
        count > 0
          ? this._msg("import-button", { count })
          : this._msg("no-tiles");
      this._importBtn.disabled = count === 0;
    }
    if (this._selectionCounter) {
      this._selectionCounter.textContent = `${count} / ${total} selected`;
      this._selectionCounter.title = `${count} of ${total} tiles selected`;
    }
  }

  // ─── Confirm / Cancel ────────────────────────────────────────────────────────

  async _confirm() {
    const replacing = this._replaceCheckbox.checked;
    if (!this._tileGrid || (this._tileGrid.selectedCount === 0 && !replacing)) return;

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
      padding: { left: this._padding, top: this._padding, right: this._padding, bottom: this._padding },
      replaceExisting: this._replaceCheckbox.checked,
    };

    await this.onImport?.(spec);

    if (!this._keepOpenCheckbox.checked) {
      const resolve = this._resolve;
      this._close();
      resolve(null);
    } else {
      // Refresh the imported-tile highlights using the latest costume list.
      const fresh = this.getCostumes?.() ?? [];
      this._decodeCostumes(fresh).then(() => this._updateImported());
    }
  }

  _updateCancelLabel() {
    this._cancelBtn.textContent = this._keepOpenCheckbox.checked
      ? this._msg("close")
      : this._msg("cancel");
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
