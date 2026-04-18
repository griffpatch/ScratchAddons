import { findAllRigGroups, findPivotItem, getPaintLayer } from "./paper-utils.js";

const NS = "http://www.w3.org/2000/svg";

/** Helper: create an SVG element with attributes. */
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/**
 * Manages the SVG overlay that renders:
 *   - A dashed highlight box around the hovered group (edit mode only)
 *   - Orange crosshair handles for every group that has a pivot marker
 *
 * The SVG element is a DOM overlay — it is never part of the paper.Project,
 * so it cannot leak into undo snapshots or costume exports.
 */
export class RigOverlay {
  constructor(container, canvas, paper, addon) {
    this._container = container;
    this._canvas = canvas;
    this._paper = paper;
    this._addon = addon;
    this._svg = null;
    this._hoverItem = null;
    this._hoverParent = null;
    this._syncActive = false;
    this._lastViewKey = "";
    this._init();
  }

  _init() {
    this._svg = el("svg");
    this._svg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:10";
    this._addon.tab.displayNoneWhileDisabled(this._svg);
    this._container.appendChild(this._svg);
    this._startSync();
  }

  /**
   * Convert a paper-space Point to pixel coordinates within the canvas container.
   * Same pattern used by paint-gradient-editor and paint-round-corners.
   * @param {paper.Point} pt
   * @returns {{x: number, y: number}}
   */
  toSVG(pt) {
    const vp = this._paper.view.projectToView(pt);
    return { x: vp.x + this._canvas.offsetLeft, y: vp.y + this._canvas.offsetTop };
  }

  /**
   * Set hover context for edit mode.
   * @param {paper.Item|null} hoverItem   - innermost item under cursor (highlighted blue)
   * @param {paper.Item|null} parentItem  - actual/potential parent (highlighted green)
   */
  setHoverContext(hoverItem, parentItem) {
    this._hoverItem = hoverItem;
    this._hoverParent = parentItem;
    this.render();
  }

  /** Convenience setter used when parent context is not needed. */
  setHoverItem(item) {
    this.setHoverContext(item, null);
  }

  /** Redraw all overlay elements from current paper project state. */
  render() {
    if (!this._svg) return;
    while (this._svg.firstChild) this._svg.removeChild(this._svg.firstChild);

    const paintLayer = getPaintLayer(this._paper);
    if (!paintLayer) return;

    // Draw order: bones (behind) → parent highlight → hover highlight → pivot handles
    this._drawBones(paintLayer);
    if (this._hoverParent) this._drawHighlight(this._hoverParent, "#4CAF50", "6 4");
    if (this._hoverItem) this._drawHighlight(this._hoverItem, "#4C97FF", "4 3");

    for (const { pivot } of findAllRigGroups(this._paper, paintLayer)) {
      this._drawPivotHandle(pivot.position);
    }
  }

  _drawHighlight(item, stroke, dasharray) {
    const b = item.bounds;
    const corners = [b.topLeft, b.topRight, b.bottomRight, b.bottomLeft];
    const pts = corners.map((p) => this.toSVG(p));
    this._svg.appendChild(
      el("polygon", {
        points: pts.map((p) => `${p.x},${p.y}`).join(" "),
        fill: "none",
        stroke,
        "stroke-width": 2,
        "stroke-dasharray": dasharray,
      })
    );
  }

  /**
   * Draw all bones: for each rigged group, draw a tapered bone shape from its
   * nearest ancestor's pivot to its own pivot.
   */
  _drawBones(paintLayer) {
    for (const { group, pivot } of findAllRigGroups(this._paper, paintLayer)) {
      const parentPivotPos = this._nearestAncestorPivotPos(group);
      if (parentPivotPos) {
        this._drawBone(parentPivotPos, pivot.position);
      }
    }
  }

  /**
   * Walk up to find the nearest ancestor group that has a pivot marker.
   * @param {paper.Group} group
   * @returns {paper.Point|null}
   */
  _nearestAncestorPivotPos(group) {
    let current = group.parent;
    while (current && !(current instanceof this._paper.Layer)) {
      if (current instanceof this._paper.Group && !current.data?.isHelperItem) {
        const pivot = findPivotItem(current);
        if (pivot) return pivot.position;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Draw a classic rig bone — a diamond/teardrop shape from `fromWorld` (parent
   * pivot, the head) to `toWorld` (child pivot, the tail).  The widest point sits
   * 20% along the bone from the head, giving an arrowhead-like silhouette.
   */
  _drawBone(fromWorld, toWorld) {
    const from = this.toSVG(fromWorld);
    const to = this.toSVG(toWorld);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;

    const ux = dx / len;
    const uy = dy / len;
    // Perpendicular unit vector
    const px = -uy;
    const py = ux;
    const w = Math.min(8, len * 0.18); // half-width of the widest section
    const kx = from.x + ux * len * 0.2;
    const ky = from.y + uy * len * 0.2;

    const pts = [
      `${from.x},${from.y}`,
      `${kx + px * w},${ky + py * w}`,
      `${to.x},${to.y}`,
      `${kx - px * w},${ky - py * w}`,
    ].join(" ");

    this._svg.appendChild(
      el("polygon", {
        points: pts,
        fill: "rgba(255,180,50,0.22)",
        stroke: "#FF9500",
        "stroke-width": 1.2,
        "stroke-linejoin": "round",
      })
    );
  }

  _drawPivotHandle(worldPt) {
    const { x, y } = this.toSVG(worldPt);
    const g = el("g");
    g.setAttribute("transform", `translate(${x},${y})`);
    // Drop-shadow then main circle with orange crosshair.
    g.appendChild(el("circle", { r: 8, fill: "rgba(0,0,0,0.2)" }));
    g.appendChild(el("circle", { r: 6, fill: "white", stroke: "#FF6B00", "stroke-width": 2 }));
    g.appendChild(el("line", { x1: -4, y1: 0, x2: 4, y2: 0, stroke: "#FF6B00", "stroke-width": 1.5 }));
    g.appendChild(el("line", { x1: 0, y1: -4, x2: 0, y2: 4, stroke: "#FF6B00", "stroke-width": 1.5 }));
    this._svg.appendChild(g);
  }

  /** Poll the view matrix and re-render when the user pans or zooms. */
  _startSync() {
    this._syncActive = true;
    const loop = () => {
      if (!this._syncActive) return;
      const m = this._paper.view.matrix;
      const key = `${m.a.toFixed(3)},${m.tx.toFixed(1)},${m.ty.toFixed(1)}`;
      if (key !== this._lastViewKey) {
        this._lastViewKey = key;
        this.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  destroy() {
    this._syncActive = false;
    this._svg?.remove();
    this._svg = null;
  }
}
