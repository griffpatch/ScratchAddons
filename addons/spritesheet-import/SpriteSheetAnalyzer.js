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
   * Compute the mean alpha on boundary lines, only counting pixels that are
   * adjacent to content (at least one perpendicular neighbor has alpha > 0).
   * This prevents large transparent margins from falsely rewarding coarse grids.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {number} mean boundary alpha in [0, 255], or 255 if no content near any boundary
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
      const xL = Math.max(0, x - 1);
      const xR = Math.min(w - 1, x + 1);
      const boundary = ctx.getImageData(x, 0, 1, h).data;
      const left = ctx.getImageData(xL, 0, 1, h).data;
      const right = ctx.getImageData(xR, 0, 1, h).data;
      for (let i = 3; i < boundary.length; i += 4) {
        if (left[i] > 0 || boundary[i] > 0 || right[i] > 0) {
          sum += boundary[i];
          count++;
        }
      }
    }

    // Sample horizontal boundary lines (between rows).
    for (let r = 1; r < rows; r++) {
      const y = Math.round(r * tileH);
      const yA = Math.max(0, y - 1);
      const yB = Math.min(h - 1, y + 1);
      const boundary = ctx.getImageData(0, y, w, 1).data;
      const above = ctx.getImageData(0, yA, w, 1).data;
      const below = ctx.getImageData(0, yB, w, 1).data;
      for (let i = 3; i < boundary.length; i += 4) {
        if (above[i] > 0 || boundary[i] > 0 || below[i] > 0) {
          sum += boundary[i];
          count++;
        }
      }
    }

    if (count === 0) return 255;
    return sum / count;
  }

  /**
   * Preference bonus for common tile sizes and square tiles.
   * Subtracted from the alpha score so preferred grids rank higher.
   *
   * @param {number} tileW
   * @param {number} tileH
   * @returns {number}
   */
  static _preferenceBonus(tileW, tileH) {
    const PERFECT = new Set([16, 32]);
    const GOOD = new Set([8, 24, 48, 64]);
    const tw = Math.round(tileW);
    const th = Math.round(tileH);

    let bonus = 0;
    if (PERFECT.has(tw) && PERFECT.has(th)) bonus += 100;
    else if (PERFECT.has(tw) || PERFECT.has(th)) bonus += 50;
    else if (GOOD.has(tw) && GOOD.has(th)) bonus += 60;
    else if (GOOD.has(tw) || GOOD.has(th)) bonus += 25;

    // Square tiles are far more common than rectangular ones.
    if (Math.abs(tileW - tileH) < 1) bonus += 50;

    return bonus;
  }

  /**
   * Detect the most likely grid layout. Returns a ranked list (best first).
   *
   * @returns {{ cols: number, rows: number, score: number, confidence: 'high'|'medium'|'low' }[]}
   */
  detectGrid() {
    const colCandidates = SpriteSheetAnalyzer._divisors(this._width);
    const rowCandidates = SpriteSheetAnalyzer._divisors(this._height);

    const candidates = [];
    for (const cols of colCandidates) {
      for (const rows of rowCandidates) {
        if (cols === 1 && rows === 1) continue;
        const tileW = this._width / cols;
        const tileH = this._height / rows;
        const alpha = this._boundaryAlpha(cols, rows);
        const bonus = SpriteSheetAnalyzer._preferenceBonus(tileW, tileH);
        // Lower combined score = better candidate.
        const score = Math.max(0, alpha - bonus);
        candidates.push({ cols, rows, score, alpha, bonus });
      }
    }

    // 1×1 is always the last resort.
    candidates.push({ cols: 1, rows: 1, score: 255, alpha: 255, bonus: 0 });

    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.bonus !== b.bonus) return b.bonus - a.bonus;
      // Among equals, prefer more tiles (finer grid).
      return b.cols * b.rows - a.cols * a.rows;
    });

    return candidates.map((c, i) => ({
      cols: c.cols,
      rows: c.rows,
      score: c.score,
      // High confidence = transparent gutters found. Medium = strong size preference.
      confidence:
        c.alpha < 10 ? "high"
        : c.alpha < 60 ? "medium"
        : c.bonus >= 100 && i === 0 ? "medium"
        : "low",
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
   * Detect the predominant transparent inner margin across all non-blank tiles.
   * Scans the transparent border on each side of every non-blank tile, then
   * takes the median per side. Outlier frames that bleed to the edge lower the
   * median slightly but don't collapse it, so a few "large" frames don't ruin
   * the result for the majority.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {{ left: number, top: number, right: number, bottom: number }}
   */
  detectPadding(cols, rows) {
    const tileW = Math.floor(this._width / cols);
    const tileH = Math.floor(this._height / rows);

    const lefts = [], tops = [], rights = [], bottoms = [];

    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const imageData = this.getTileImageData(c, r, cols, rows);
        if (this.isTileBlank(imageData)) continue;

        const { data } = imageData;
        const W = imageData.width;
        const H = imageData.height;

        // Find transparent border on each side.
        let left = W, top = H, right = W, bottom = H;

        // Left: scan columns left-to-right until a non-transparent pixel
        outer: for (let x = 0; x < W; x++) {
          for (let y = 0; y < H; y++) {
            if (data[(y * W + x) * 4 + 3] > 0) { left = x; break outer; }
          }
        }
        // Right: scan columns right-to-left
        outer: for (let x = W - 1; x >= 0; x--) {
          for (let y = 0; y < H; y++) {
            if (data[(y * W + x) * 4 + 3] > 0) { right = W - 1 - x; break outer; }
          }
        }
        // Top: scan rows top-to-bottom
        outer: for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] > 0) { top = y; break outer; }
          }
        }
        // Bottom: scan rows bottom-to-top
        outer: for (let y = H - 1; y >= 0; y--) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] > 0) { bottom = H - 1 - y; break outer; }
          }
        }

        lefts.push(left);
        tops.push(top);
        rights.push(right);
        bottoms.push(bottom);
      }
    }

    if (lefts.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };

    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 === 1 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
    };

    return {
      left: median(lefts),
      top: median(tops),
      right: median(rights),
      bottom: median(bottoms),
    };
  }

  /**
   * Fast djb2-based hash over raw pixel bytes. Used to detect identical tile content.
   *
   * @param {ImageData} imageData
   * @returns {number}
   */
  static hashImageData(imageData) {
    let h = 5381;
    const { data } = imageData;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) + h + data[i]) >>> 0;
    }
    return h;
  }
}
