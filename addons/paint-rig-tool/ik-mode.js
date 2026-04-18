import { findGroupAtPoint, getAncestorRigChain, getPivotPos } from "./paper-utils.js";

const MAX_ITERATIONS = 10;
const STOP_THRESHOLD = 2; // paper units — close enough to stop iterating

/**
 * IK mode: drag any point on a rigged group to pull it toward the cursor.
 *
 * Uses CCD (Cyclic Coordinate Descent) IK over the chain of ancestor groups
 * that have pivot markers, starting from the grabbed group and walking outward
 * toward the painting layer root. Each joint in turn is rotated around its pivot
 * to bring the end effector as close as possible to the target.
 *
 * Degenerates cleanly to single-joint rotation when only one joint is reachable.
 */
export class IKMode {
  constructor({ addon, paper, overlay, onChanged }) {
    this._addon = addon;
    this._paper = paper;
    this._overlay = overlay;
    this._onChanged = onChanged;
    this._tool = null;
    this._active = null; // { chain, innerGroup, localEE }
  }

  activate() {
    const paper = this._paper;
    this._tool = new paper.Tool();

    this._tool.onMouseDown = (e) => {
      if (this._addon.self.disabled) return;
      const group = findGroupAtPoint(paper, e.point);
      if (!group) return;
      const chain = getAncestorRigChain(paper, group);
      if (chain.length === 0) return;
      // Store the end-effector in world space.  On each drag frame the target
      // IS the cursor, and we solve to bring worldEE to the cursor.  We track
      // worldEE ourselves (updated after each solve) rather than mapping a fixed
      // local point through an ever-changing transform chain, which would drift.
      this._active = { chain, worldEE: e.point.clone() };
    };

    this._tool.onMouseDrag = (e) => {
      if (this._addon.self.disabled || !this._active) return;
      const { chain } = this._active;
      this._active.worldEE = this._solveCCD(chain, this._active.worldEE, e.point);
      this._overlay.render();
      paper.view.update();
    };

    this._tool.onMouseUp = () => {
      if (this._active) {
        this._onChanged();
        this._active = null;
      }
    };

    this._tool.activate();
  }

  /**
   * CCD IK solver — all coordinates in world space.
   *
   * The end effector (EE) is a point that starts at the grabbed location and
   * should reach `target` (the cursor).  Each joint rotates to align
   * pivot→EE with pivot→target, moving EE in the process.  After all joints
   * have been processed once the new world position of the EE is returned so
   * it can be stored for the next drag frame.
   *
   * Working entirely in world space avoids the local↔global drift that occurs
   * when parent transforms are mutated by earlier iterations.
   *
   * @param {paper.Group[]} chain    - innermost to outermost
   * @param {paper.Point}   worldEE  - current world position of the end effector
   * @param {paper.Point}   target   - desired world position (cursor)
   * @returns {paper.Point} updated world position of the EE after solving
   */
  _solveCCD(chain, worldEE, target) {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (worldEE.subtract(target).length < STOP_THRESHOLD) break;

      for (const group of chain) {
        const pivot = getPivotPos(group);
        if (!pivot) continue;

        const fromVec = worldEE.subtract(pivot);
        const toVec = target.subtract(pivot);
        if (fromVec.length < 0.5 || toVec.length < 0.5) continue;

        let angleDelta = toVec.angle - fromVec.angle;
        if (angleDelta > 180) angleDelta -= 360;
        else if (angleDelta < -180) angleDelta += 360;

        // Rotate the group around the pivot in world space.
        group.rotate(angleDelta, pivot);

        // Rotate the EE by the same angle around the same pivot so it stays
        // attached to the innermost group as the chain moves.
        worldEE = worldEE.subtract(pivot).rotate(angleDelta).add(pivot);
      }
    }
    return worldEE;
  }

  destroy() {
    this._tool?.remove();
    this._tool = null;
    this._active = null;
  }
}
