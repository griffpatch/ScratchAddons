/**
 * SpriteSheetAnalyzer — image analysis for sprite sheet grid detection.
 *
 * Responsibilities:
 *  - Enumerate candidate grid sizes and rank them by boundary transparency.
 *  - Detect blank (fully transparent) tiles.
 *  - Produce a fast hash of tile pixel data for identity comparison.
 */
export default class SpriteSheetAnalyzer {
  /**
   * @param {HTMLImageElement} img - Fully-loaded image element.
   */
  constructor(img) {
    this._img = img;
    this._width = img.naturalWidth;
    this._height = img.naturalHeight;

    // Render image once into an offscreen canvas so pixel data is available.
    this._canvas = document.createElement("canvas");
    this._canvas.width = this._width;
    this._canvas.height = this._height;
    const ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    this._ctx = ctx;
  }

  get imageWidth() {
    return this._width;
  }

  get imageHeight() {
    return this._height;
  }

  /**
   * Return all integer divisors of n, capped at maxDivisors.
   * @param {number} n
   * @param {number} maxDivisors
   * @returns {number[]}
   */
  static _divisors(n, maxDivisors = 64) {
    const divs = [];
    for (let i = 1; i <= n && divs.length < maxDivisors; i++) {
      if (n % i === 0) divs.push(i);
    }
    return divs;
  }

  /**
   * Compute the mean alpha value along all inter-tile boundary lines for the
   * given grid dimensions. Lower mean alpha = more transparent gutters = better fit.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {number} mean boundary alpha in [0, 255]
   */
  _boundaryAlpha(cols, rows) {
    const { _width: w, _height: h, _ctx: ctx } = this;
    const tileW = w / cols;
    const tileH = h / rows;

    let sum = 0;
    let count = 0;

    // Sample vertical boundary lines (between columns).
    for (let c = 1; c < cols; c++) {
      const x = Math.round(c * tileW);
      const col = ctx.getImageData(x, 0, 1, h).data;
      for (let i = 3; i < col.length; i += 4) {
        sum += col[i];
        count++;
      }
    }

    // Sample horizontal boundary lines (between rows).
    for (let r = 1; r < rows; r++) {
      const y = Math.round(r * tileH);
      const row = ctx.getImageData(0, y, w, 1).data;
      for (let i = 3; i < row.length; i += 4) {
        sum += row[i];
        count++;
      }
    }

    // A single-tile grid has no boundaries; treat as worst case.
    if (count === 0) return 255;
    return sum / count;
  }

  /**
   * Detect the most likely grid layout. Returns a ranked list (best first).
   *
   * @returns {{ cols: number, rows: number, score: number, confidence: 'high'|'medium'|'low' }[]}
   */
  detectGrid() {
    const colCandidates = SpriteSheetAnalyzer._divisors(this._width);
    const rowCandidates = SpriteSheetAnalyzer._divisors(this._height);

    // Skip the trivial 1×1 case unless it is the only option.
    const candidates = [];
    for (const cols of colCandidates) {
      for (const rows of rowCandidates) {
        if (cols === 1 && rows === 1) continue;
        const score = this._boundaryAlpha(cols, rows);
        candidates.push({ cols, rows, score });
      }
    }

    // Also include 1×1 as a last resort.
    candidates.push({ cols: 1, rows: 1, score: 255 });

    candidates.sort((a, b) => a.score - b.score);

    // Tag confidence based on the score of the top candidate.
    return candidates.map((c) => ({
      ...c,
      confidence: c.score < 10 ? "high" : c.score < 60 ? "medium" : "low",
    }));
  }

  /**
   * Return the raw ImageData for a single tile.
   *
   * @param {number} col - 1-based column index.
   * @param {number} row - 1-based row index.
   * @param {number} cols - Total columns.
   * @param {number} rows - Total rows.
   * @returns {ImageData}
   */
  getTileImageData(col, row, cols, rows) {
    const tileW = Math.floor(this._width / cols);
    const tileH = Math.floor(this._height / rows);
    const x = (col - 1) * tileW;
    const y = (row - 1) * tileH;
    return this._ctx.getImageData(x, y, tileW, tileH);
  }

  /**
   * Return true if every pixel in the ImageData is fully transparent.
   *
   * @param {ImageData} imageData
   * @returns {boolean}
   */
  isTileBlank(imageData) {
    const { data } = imageData;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false;
    }
    return true;
  }

  /**
   * Fast djb2-based hash over pixel bytes. Used to detect identity.
   *
   * @param {ImageData} imageData
   * @returns {number}
   */
  hashImageData(imageData) {
    let h = 5381;
    const { data } = imageData;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) + h + data[i]) >>> 0;
    }
    return h;
  }
}
