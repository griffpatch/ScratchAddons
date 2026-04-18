import { findInnermostRigGroupAtPoint, getPivotPos } from "./paper-utils.js";

/**
 * Move mode: click-drag anywhere on a rigged group to rotate it around its pivot.
 *
 * Rotation angle is derived from the angular difference between successive mouse
 * positions relative to the pivot point. This gives smooth, direct control — the
 * shape always follows the cursor's orbiting motion around the joint.
 */
export class MoveMode {
  constructor({ addon, paper, overlay, onChanged }) {
    this._addon = addon;
    this._paper = paper;
    this._overlay = overlay;
    this._onChanged = onChanged;
    this._tool = null;
    this._active = null; // { group, pivotPos, lastPt } while dragging
  }

  activate() {
    const paper = this._paper;
    this._tool = new paper.Tool();

    this._tool.onMouseDown = (e) => {
      if (this._addon.self.disabled) return;
      const group = findInnermostRigGroupAtPoint(paper, e.point);
      if (!group) return;
      const pivotPos = getPivotPos(group);
      if (!pivotPos) return; // group has no pivot — cannot rotate
      this._active = { group, pivotPos, lastPt: e.point };
    };

    this._tool.onMouseDrag = (e) => {
      if (this._addon.self.disabled || !this._active) return;
      const { group, pivotPos } = this._active;
      const fromVec = this._active.lastPt.subtract(pivotPos);
      const toVec = e.point.subtract(pivotPos);
      // Only rotate when both vectors have meaningful length to avoid
      // division instability when the cursor is exactly on the pivot.
      if (fromVec.length > 0.5 && toVec.length > 0.5) {
        // Normalise to [-180, 180] to prevent snapping at the ±180° boundary.
        let angleDelta = toVec.angle - fromVec.angle;
        if (angleDelta > 180) angleDelta -= 360;
        else if (angleDelta < -180) angleDelta += 360;
        group.rotate(angleDelta, pivotPos);
        this._overlay.render();
        paper.view.update();
      }
      this._active.lastPt = e.point;
    };

    this._tool.onMouseUp = () => {
      if (this._active) {
        this._onChanged();
        this._active = null;
      }
    };

    this._tool.activate();
  }

  destroy() {
    this._tool?.remove();
    this._tool = null;
    this._active = null;
  }
}
