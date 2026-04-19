/**
 * SpriteSheetImporter — tile extraction and costume import into the Scratch VM.
 *
 * Replicates the PNG import path from scratch-gui's costumeUpload / createVMAsset
 * without depending on those unexported functions.
 *
 * Anchor index mapping (0-8, left-to-right, top-to-bottom):
 *   0=top-left  1=top-center  2=top-right
 *   3=mid-left  4=center      5=mid-right
 *   6=bot-left  7=bot-center  8=bot-right
 */
export default class SpriteSheetImporter {
  /**
   * @param {object} vm - The Scratch VM instance (`addon.tab.traps.vm`).
   * @param {string} targetId - The sprite target ID captured at dialog-open time.
   */
  constructor(vm, targetId) {
    this._vm = vm;
    this._targetId = targetId;
    this._storage = vm.runtime.storage;
    // Reuse a single offscreen canvas for tile extraction.
    this._tileCanvas = document.createElement("canvas");
    this._tileCtx = this._tileCanvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * Compute rotationCenter from anchor index and tile dimensions.
   *
   * @param {number} anchorIndex - 0–8
   * @param {number} tileW - tile width in pixels
   * @param {number} tileH - tile height in pixels
   * @returns {{ x: number, y: number }}
   */
  static anchorToCenter(anchorIndex, tileW, tileH) {
    const col = anchorIndex % 3; // 0=left, 1=center, 2=right
    const row = Math.floor(anchorIndex / 3); // 0=top, 1=mid, 2=bot
    return {
      x: (col / 2) * tileW,
      y: (row / 2) * tileH,
    };
  }

  /**
   * Import all selected tiles from `img` as bitmap costumes.
   *
   * @param {HTMLImageElement} img - The fully-loaded sprite sheet.
   * @param {object} spec
   * @param {Array<{col: number, row: number}>} spec.tiles - Tiles to import (1-based).
   * @param {number} spec.cols - Total columns in the grid.
   * @param {number} spec.rows - Total rows in the grid.
   * @param {string} spec.baseName - Costume name prefix.
   * @param {number} spec.anchorIndex - 0–8 anchor position.
   * @param {Function} [spec.onProgress] - Called with (imported, total) after each tile.
   */
  async import(img, { tiles, cols, rows, baseName, anchorIndex, onProgress }) {
    const storage = this._storage;
    const vm = this._vm;

    const tileW = Math.floor(img.naturalWidth / cols);
    const tileH = Math.floor(img.naturalHeight / rows);
    const { x: rotCenterX, y: rotCenterY } = SpriteSheetImporter.anchorToCenter(
      anchorIndex,
      tileW,
      tileH
    );

    this._tileCanvas.width = tileW;
    this._tileCanvas.height = tileH;

    const target = vm.runtime.getTargetById(this._targetId);
    if (!target) throw new Error(`SpriteSheetImporter: target ${this._targetId} not found`);

    for (let i = 0; i < tiles.length; i++) {
      const { col, row } = tiles[i];
      const costumeName = `${baseName}:${col}:${row}`;

      const arrayBuffer = await this._extractTile(img, col, row, tileW, tileH);

      // Build the VM costume asset (mirrors createVMAsset in scratch-gui/file-uploader.js).
      // scratch-storage computes the content MD5 as assetId when generateId = true.
      const dataFormat = storage.DataFormat.PNG;
      const asset = storage.createAsset(
        storage.AssetType.ImageBitmap,
        dataFormat,
        new Uint8Array(arrayBuffer),
        null,
        true // generate md5 from content
      );

      // Check for existing costume with the same name.
      const existingIndex = target.sprite.costumes_.findIndex(
        (c) => c.name === costumeName
      );
      if (existingIndex !== -1) {
        const existing = target.sprite.costumes_[existingIndex];
        // Skip if content is identical (same content MD5 = same assetId).
        if (existing.asset?.assetId === asset.assetId) {
          onProgress?.(i + 1, tiles.length);
          continue;
        }
        // Replace: remove old costume first, then fall through to add new one.
        target.sprite.deleteCostumeAt(existingIndex);
        if (target.currentCostume >= existingIndex) {
          target.currentCostume = Math.max(0, target.currentCostume - 1);
        }
      }

      const vmCostume = {
        name: costumeName,
        dataFormat,
        asset,
        md5: `${asset.assetId}.${dataFormat}`,
        assetId: asset.assetId,
        rotationCenterX: rotCenterX,
        rotationCenterY: rotCenterY,
        bitmapResolution: 1,
        skinId: null,
      };

      // vm.addCostume stores the asset in storage and appends the costume.
      await vm.addCostume(vmCostume.md5, vmCostume, this._targetId);

      onProgress?.(i + 1, tiles.length);
    }

    // Emit a targets update so the UI reflects the new costumes.
    vm.emitTargetsUpdate?.();
  }

  /**
   * Draw one tile from `img` onto the tile canvas and return its PNG as ArrayBuffer.
   *
   * @param {HTMLImageElement} img
   * @param {number} col - 1-based
   * @param {number} row - 1-based
   * @param {number} tileW
   * @param {number} tileH
   * @returns {Promise<ArrayBuffer>}
   */
  _extractTile(img, col, row, tileW, tileH) {
    const sx = (col - 1) * tileW;
    const sy = (row - 1) * tileH;
    this._tileCtx.clearRect(0, 0, tileW, tileH);
    this._tileCtx.drawImage(img, sx, sy, tileW, tileH, 0, 0, tileW, tileH);
    return new Promise((resolve, reject) => {
      this._tileCanvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("SpriteSheetImporter: toBlob returned null"));
          return;
        }
        blob.arrayBuffer().then(resolve, reject);
      }, "image/png");
    });
  }
}
