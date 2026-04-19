import SpriteSheetAnalyzer from "./SpriteSheetAnalyzer.js";
import SpriteSheetTileGrid from "./SpriteSheetTileGrid.js";

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
    this._anchorIndex = 4; // centre by default
  }

  /**
   * Open the dialog for the given image file.
   *
   * @param {File} file
   * @returns {Promise<ImportSpec | null>}
   *   Resolves with { tiles, cols, rows, baseName, anchorIndex } or null on cancel.
   */
  open(file) {
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

    // Preview area: outer wrap + inner (inline-block to size to image) + canvas overlay
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

    // Grid controls row
    const gridControls = Object.assign(document.createElement("div"), {
      className: "sa-ss-grid-controls",
    });

    // Columns
    const colsLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-spinner-label",
    });
    colsLabel.append(
      Object.assign(document.createElement("span"), { textContent: msg("columns") })
    );
    this._colsInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "512",
      value: "1",
    });
    colsLabel.append(this._colsInput);

    // Rows
    const rowsLabel = Object.assign(document.createElement("label"), {
      className: "sa-ss-spinner-label",
    });
    rowsLabel.append(
      Object.assign(document.createElement("span"), { textContent: msg("rows") })
    );
    this._rowsInput = Object.assign(document.createElement("input"), {
      type: "number",
      className: "sa-ss-spinner",
      min: "1",
      max: "512",
      value: "1",
    });
    rowsLabel.append(this._rowsInput);

    // Auto-detect button
    this._autoDetectBtn = Object.assign(document.createElement("button"), {
      className: "sa-ss-btn sa-ss-btn-secondary",
      textContent: msg("auto-detect"),
    });

    // Confidence message
    this._detectMsg = Object.assign(document.createElement("span"), {
      className: "sa-ss-detect-msg",
    });

    gridControls.append(colsLabel, rowsLabel, this._autoDetectBtn, this._detectMsg);

    // Selection controls row
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

    // Costume name row
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

    // Anchor picker row
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
    this._dialog.append(
      title,
      this._previewWrap,
      gridControls,
      selControls,
      nameRow,
      anchorRow,
      footer
    );
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
    this._colsInput.addEventListener("change", () => this._onGridInputChange());
    this._rowsInput.addEventListener("change", () => this._onGridInputChange());

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
      this._overlayCanvas.width = this._analyzer.imageWidth;
      this._overlayCanvas.height = this._analyzer.imageHeight;
      this._runAutoDetect();
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
    const cols = Math.max(1, parseInt(this._colsInput.value, 10) || 1);
    const rows = Math.max(1, parseInt(this._rowsInput.value, 10) || 1);
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
    this._colsInput.value = String(cols);
    this._rowsInput.value = String(rows);

    // Compute initial selection: all non-blank tiles.
    const selected = new Set();
    if (this._analyzer) {
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= cols; c++) {
          const tileData = this._analyzer.getTileImageData(c, r, cols, rows);
          if (!this._analyzer.isTileBlank(tileData)) {
            selected.add(`${c}:${r}`);
          }
        }
      }
    }

    if (this._tileGrid) {
      this._tileGrid.setGrid(cols, rows, selected);
    } else {
      this._tileGrid = new SpriteSheetTileGrid(
        this._overlayCanvas,
        cols,
        rows,
        selected
      );
      this._tileGrid.onSelectionChange = () => this._updateImportButton();
    }

    this._updateImportButton();
  }

  // ─── Anchor ─────────────────────────────────────────────────────────────────

  _setAnchor(index) {
    this._anchorIndex = index;
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
    this._resolve = null;
  }
}
