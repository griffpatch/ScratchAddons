/**
 * Sprite sheet pixel analysis — grid detection, padding, and tile classification.
 *
 * Exported functions:
 *   analyzeImage(img)        — Initialize pixel state and run full analysis.
 *                              Returns { width, height, candidates, padding, blank, hashes }.
 *   classifyGrid(cols, rows) — Classify a specific grid layout.
 *                              Returns { blank, hashes }. Requires analyzeImage() first.
 *
 * The hash algorithm in classifyTiles() MUST stay byte-for-byte identical to
 * hashPixelData() in SpriteSheetDialog.js — both sides hash costume pixel data
 * for comparison.
 */

// Pixel state — initialized by analyzeImage(), reused by classifyGrid().
let _pixels = null;
let _width = 0,
  _height = 0;

// Per-column boundary statistics: for each x, sum and count of alpha values at rows
// where the horizontal neighbourhood (x-1..x+1) has any alpha. Lets boundaryAlpha()
// query any column boundary in O(1) instead of scanning the full image height.
let _colBndSum = null,
  _colBndCount = null;

// Per-row boundary statistics: same idea for horizontal boundaries.
let _rowBndSum = null,
  _rowBndCount = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function divisors(n, max) {
  const d = [];
  for (let i = 1; i <= n && d.length < max; i++) if (n % i === 0) d.push(i);
  return d;
}

// ─── Grid detection ───────────────────────────────────────────────────────────

// Uses precomputed _colBndSum/_rowBndSum arrays — O(1) per boundary column/row.
function boundaryAlpha(cols, rows) {
  const tileW = _width / cols,
    tileH = _height / rows;
  let sum = 0,
    count = 0;
  for (let c = 1; c < cols; c++) {
    const x = Math.round(c * tileW);
    sum += _colBndSum[x];
    count += _colBndCount[x];
  }
  for (let r = 1; r < rows; r++) {
    const y = Math.round(r * tileH);
    sum += _rowBndSum[y];
    count += _rowBndCount[y];
  }
  return count === 0 ? 255 : sum / count;
}

function preferenceBonus(tileW, tileH) {
  const PERFECT = [16, 32],
    GOOD = [8, 24, 48, 64];
  const tw = Math.round(tileW),
    th = Math.round(tileH);
  const inP = (v) => PERFECT.includes(v),
    inG = (v) => GOOD.includes(v);
  let bonus = 0;
  if (inP(tw) && inP(th)) bonus += 100;
  else if (inP(tw) || inP(th)) bonus += 50;
  else if (inG(tw) && inG(th)) bonus += 60;
  else if (inG(tw) || inG(th)) bonus += 25;
  if (Math.abs(tileW - tileH) < 1) bonus += 50;
  return bonus;
}

function detectGrid() {
  const colC = divisors(_width, 64),
    rowC = divisors(_height, 64);
  const cands = [];
  for (const cols of colC) {
    for (const rows of rowC) {
      if (cols === 1 && rows === 1) continue;
      const tileW = _width / cols,
        tileH = _height / rows;
      // Skip grids that would produce tiles smaller than 8×8 — too small to be meaningful.
      if (tileW < 8 || tileH < 8) continue;
      const alpha = boundaryAlpha(cols, rows);
      const bonus = preferenceBonus(tileW, tileH);
      cands.push({ cols, rows, tileW, tileH, score: Math.max(0, alpha - bonus), alpha, bonus });
    }
  }
  cands.push({ cols: 1, rows: 1, tileW: _width, tileH: _height, score: 255, alpha: 255, bonus: 0 });
  cands.sort((a, b) =>
    a.score !== b.score
      ? a.score - b.score
      : b.bonus !== a.bonus
        ? b.bonus - a.bonus
        : b.cols * b.rows - a.cols * a.rows
  );

  // Subdivision promotion: a coarser grid (e.g. 32×32) can score lower than a finer
  // grid (16×16) purely because it has fewer boundary lines to sample — not because
  // it is more correct. If a finer grid that evenly subdivides the winner is within
  // SUBDIVISION_GRACE score points, promote it.
  const SUBDIVISION_GRACE = 40;
  const winner = cands[0];
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i];
    if (c.score > winner.score + SUBDIVISION_GRACE) break;
    const winTW = Math.round(winner.tileW),
      winTH = Math.round(winner.tileH);
    const cTW = Math.round(c.tileW),
      cTH = Math.round(c.tileH);
    // c must be a strictly finer grid whose tile size evenly divides the winner's.
    if (cTW < winTW && cTH < winTH && winTW % cTW === 0 && winTH % cTH === 0) {
      cands.splice(i, 1);
      cands.unshift(c);
      break;
    }
  }

  return cands.map((c, i) => ({
    cols: c.cols,
    rows: c.rows,
    score: c.score,
    confidence: c.alpha < 10 ? "high" : c.alpha < 60 ? "medium" : c.bonus >= 100 && i === 0 ? "medium" : "low",
  }));
}

// ─── Padding detection ────────────────────────────────────────────────────────

function detectPadding(cols, rows) {
  const tileW = Math.floor(_width / cols),
    tileH = Math.floor(_height / rows);
  const lefts = [],
    tops = [],
    rights = [],
    bottoms = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const x0 = (c - 1) * tileW,
        y0 = (r - 1) * tileH;
      let blank = true;
      outer: for (let ty = 0; ty < tileH; ty++)
        for (let tx = 0; tx < tileW; tx++)
          if (_pixels[((y0 + ty) * _width + x0 + tx) * 4 + 3]) {
            blank = false;
            break outer;
          }
      if (blank) continue;
      let l = tileW,
        t = tileH,
        ri = tileW,
        b = tileH;
      outer: for (let tx = 0; tx < tileW; tx++)
        for (let ty = 0; ty < tileH; ty++) {
          if (_pixels[((y0 + ty) * _width + x0 + tx) * 4 + 3]) {
            l = tx;
            break outer;
          }
        }
      outer: for (let tx = tileW - 1; tx >= 0; tx--)
        for (let ty = 0; ty < tileH; ty++) {
          if (_pixels[((y0 + ty) * _width + x0 + tx) * 4 + 3]) {
            ri = tileW - 1 - tx;
            break outer;
          }
        }
      outer: for (let ty = 0; ty < tileH; ty++)
        for (let tx = 0; tx < tileW; tx++) {
          if (_pixels[((y0 + ty) * _width + x0 + tx) * 4 + 3]) {
            t = ty;
            break outer;
          }
        }
      outer: for (let ty = tileH - 1; ty >= 0; ty--)
        for (let tx = 0; tx < tileW; tx++) {
          if (_pixels[((y0 + ty) * _width + x0 + tx) * 4 + 3]) {
            b = tileH - 1 - ty;
            break outer;
          }
        }
      lefts.push(l);
      tops.push(t);
      rights.push(ri);
      bottoms.push(b);
    }
  }
  if (!lefts.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y),
      m = s.length >> 1;
    return s.length & 1 ? s[m] : (s[m - 1] + s[m]) >> 1;
  };
  return { left: median(lefts), top: median(tops), right: median(rights), bottom: median(bottoms) };
}

// ─── Tile classification ──────────────────────────────────────────────────────

function classifyTiles(cols, rows) {
  const tileW = Math.floor(_width / cols),
    tileH = Math.floor(_height / rows);
  const blank = [],
    hashes = {};
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const x0 = (c - 1) * tileW,
        y0 = (r - 1) * tileH;
      // Compute blank check and djb2 hash in one pass over _pixels.
      // Iteration order (row-major within tile) matches getImageData layout, so
      // the hash is byte-for-byte identical to hashPixelData() in SpriteSheetDialog.js.
      let isBlank = true,
        h = 5381;
      for (let ty = 0; ty < tileH; ty++) {
        for (let tx = 0; tx < tileW; tx++) {
          const pi = ((y0 + ty) * _width + x0 + tx) * 4;
          if (_pixels[pi + 3]) isBlank = false;
          h = ((h << 5) + h + _pixels[pi]) | 0;
          h = ((h << 5) + h + _pixels[pi + 1]) | 0;
          h = ((h << 5) + h + _pixels[pi + 2]) | 0;
          h = ((h << 5) + h + _pixels[pi + 3]) | 0;
        }
      }
      const key = `${c}:${r}`;
      if (isBlank) blank.push(key);
      else hashes[key] = h >>> 0;
    }
  }
  return { blank, hashes };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Draw img into an offscreen canvas, precompute boundary statistics, detect the
 * best grid, detect padding, and classify tiles for the best candidate.
 *
 * @param {HTMLImageElement} img - A fully loaded spritesheet image.
 * @returns {{ width: number, height: number, candidates: object[], padding: object,
 *             blank: string[], hashes: Record<string, number> }}
 */
export function analyzeImage(img) {
  _width = img.naturalWidth;
  _height = img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = _width;
  canvas.height = _height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  // Read the full image once. All subsequent analysis reads from _pixels directly.
  _pixels = ctx.getImageData(0, 0, _width, _height).data;

  // Precompute per-column and per-row boundary alpha statistics.
  // _colBndSum[x] / _colBndCount[x]: sum and count of alpha values at column x in rows
  //   where the horizontal neighbourhood (x-1, x, x+1) has any alpha.
  // _rowBndSum[y] / _rowBndCount[y]: same for horizontal boundary rows.
  // This lets boundaryAlpha() query any boundary in O(1).
  _colBndSum = new Float64Array(_width);
  _colBndCount = new Int32Array(_width);
  _rowBndSum = new Float64Array(_height);
  _rowBndCount = new Int32Array(_height);
  for (let y = 0; y < _height; y++) {
    const rowBase = y * _width;
    for (let x = 0; x < _width; x++) {
      const a = _pixels[(rowBase + x) * 4 + 3];
      const al = x > 0 ? _pixels[(rowBase + x - 1) * 4 + 3] : 0;
      const ar = x < _width - 1 ? _pixels[(rowBase + x + 1) * 4 + 3] : 0;
      if (al > 0 || a > 0 || ar > 0) {
        _colBndSum[x] += a;
        _colBndCount[x]++;
      }
    }
  }
  for (let x = 0; x < _width; x++) {
    for (let y = 0; y < _height; y++) {
      const a = _pixels[(y * _width + x) * 4 + 3];
      const at = y > 0 ? _pixels[((y - 1) * _width + x) * 4 + 3] : 0;
      const ab = y < _height - 1 ? _pixels[((y + 1) * _width + x) * 4 + 3] : 0;
      if (at > 0 || a > 0 || ab > 0) {
        _rowBndSum[y] += a;
        _rowBndCount[y]++;
      }
    }
  }

  const candidates = detectGrid();
  const best = candidates[0];
  const padding = detectPadding(best.cols, best.rows);
  const { blank, hashes } = classifyTiles(best.cols, best.rows);

  return { width: _width, height: _height, candidates, padding, blank, hashes };
}

/**
 * Classify a specific grid layout, reusing the pixel state from the last analyzeImage() call.
 *
 * @param {number} cols
 * @param {number} rows
 * @returns {{ blank: string[], hashes: Record<string, number> }}
 */
export function classifyGrid(cols, rows) {
  return classifyTiles(cols, rows);
}
