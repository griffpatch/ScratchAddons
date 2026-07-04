import {
  findGroupAtPoint,
  findAllPaintRootItemsAtPoint,
  findInnermostRigGroupUnderPoint,
  findPivotItem,
  createPivotAt,
  deletePivot,
  getPaintLayer,
} from "./paper-utils.js";

// Screen-space radius (px) within which a click counts as hitting a pivot handle.
const PIVOT_HIT_PX = 12;

/**
 * Edit mode: hover highlights groups, click adds a pivot to a group, drag moves
 * an existing pivot, and double-click deletes a pivot.
 *
 * Paper.js event sequence for a double-click:
 *   mousedown → mouseup → mousedown → doubleClick
 * So mousedown fires twice before doubleClick. We guard create-on-click by
 * checking whether an existing pivot is nearby first; if the pivot was just
 * created by the first mousedown, the second mousedown finds it and sets up a
 * drag, and doubleClick then deletes it — net result is correct deletion.
 */
export class EditMode {
  constructor({ addon, paper, overlay, onChanged }) {
    this._addon = addon;
    this._paper = paper;
    this._overlay = overlay;
    this._onChanged = onChanged;
    this._tool = null;
    this._hoverItem = null;
    this._hoverParent = null;
    this._dragging = null; // { pivot } while a pivot is being dragged
    this._onDblClick = null;
  }

  activate() {
    const paper = this._paper;
    this._tool = new paper.Tool();

    this._tool.onMouseMove = (e) => {
      if (this._addon.self.disabled) return;

      // hoverItem: innermost group under cursor, or bare top root item if no group.
      const rootItems = findAllPaintRootItemsAtPoint(paper, e.point);
      const innermost = findGroupAtPoint(paper, e.point);
      const hoverItem = innermost ?? rootItems[0] ?? null;

      // parentItem: the group that already is — or on click will become — the parent.
      //   • If hoverItem is already nested inside a rigged ancestor → show that ancestor.
      //   • Otherwise → search ALL hits at this point (hitTestAll) for the innermost
      //     rigged group beneath the top item, so hovering over a nested limb shows the
      //     right parent even when a non-rigged item is on top.
      let parentItem = null;
      if (hoverItem) {
        let p = hoverItem.parent;
        while (p && !(p instanceof paper.Layer)) {
          if (p instanceof paper.Group && !p.data?.isHelperItem && findPivotItem(p)) {
            parentItem = p;
            break;
          }
          p = p.parent;
        }
        if (!parentItem) {
          const rigBeneath = findInnermostRigGroupUnderPoint(paper, e.point);
          if (rigBeneath && rigBeneath !== hoverItem) {
            parentItem = rigBeneath;
          } else if (!rigBeneath && rootItems.length > 1) {
            parentItem = rootItems[1];
          }
        }
      }

      if (hoverItem !== this._hoverItem || parentItem !== this._hoverParent) {
        this._hoverItem = hoverItem;
        this._hoverParent = parentItem;
        this._overlay.setHoverContext(hoverItem, parentItem);
      }
    };

    this._tool.onMouseDown = (e) => {
      if (this._addon.self.disabled) return;
      this._dragging = null;

      const paintLayer = getPaintLayer(paper);

      // Check proximity to any existing pivot handle first.
      if (paintLayer) {
        const tol = PIVOT_HIT_PX / paper.view.zoom;
        const groups = paintLayer.getItems({
          match: (i) => i instanceof paper.Group && !i.data?.isHelperItem,
        });
        for (const child of groups) {
          const pivot = findPivotItem(child);
          if (pivot && e.point.subtract(pivot.position).length <= tol) {
            this._dragging = { pivot };
            return; // intercept: start dragging this pivot
          }
        }
      }

      // No pivot nearby — pin the innermost group under the cursor and wire
      // its root-level container into the hierarchy below it.
      //
      // "Innermost group" = deepest paper.Group under the cursor (with or without
      // a pivot already).  If there is no group at all, wrap the bare shape.
      //
      // Below-wiring only happens when the resolved group is a direct child of
      // the painting layer (i.e. not already nested inside another group).

      // Before any modifications: find the deepest already-rigged group at this
      // point using hitTestAll so we can see through the topmost un-rigged item.
      // This is the correct parent target when attaching a new bone to an existing rig.
      const rigTarget = findInnermostRigGroupUnderPoint(paper, e.point);

      // Root-level items are needed for the bare-shape-below wiring edge case.
      const allRootItems = findAllPaintRootItemsAtPoint(paper, e.point);
      if (allRootItems.length === 0) return;
      const rootTopItem = allRootItems[0];
      const belowItem = allRootItems[1] ?? null;

      // Step 1 — resolve the innermost group to pin.
      const innermostGroup = findGroupAtPoint(paper, e.point);
      let topGroup;
      if (innermostGroup) {
        if (findPivotItem(innermostGroup)) return; // already pinned — no-op
        topGroup = innermostGroup;
      } else {
        // Bare shape — wrap it in a new group.
        topGroup = new paper.Group([rootTopItem]);
      }

      // Step 2 — create the pivot pin.
      createPivotAt(paper, topGroup, e.point);

      // Step 3 — wire into the hierarchy, but only if topGroup is still at
      // painting-layer root level (already-nested groups need no wiring).
      if (paintLayer && topGroup.parent === paintLayer) {
        if (rigTarget && rigTarget !== topGroup) {
          // Nest inside the deepest existing rigged limb under the cursor.
          rigTarget.addChild(topGroup);
        } else if (belowItem && !belowItem.data?.isHelperItem) {
          if (belowItem instanceof paper.Group) {
            // Nest the top group inside the group below.
            belowItem.addChild(topGroup);
          } else {
            // Bare shape below — give it its own group so it can receive a pin
            // independently later, then place both in an outer container.
            const belowGroup = new paper.Group([belowItem]);
            // eslint-disable-next-line no-new
            new paper.Group([topGroup, belowGroup]);
          }
        }
      }

      this._onChanged();
      this._overlay.render();
    };

    this._tool.onMouseDrag = (e) => {
      if (this._addon.self.disabled || !this._dragging) return;
      this._dragging.pivot.position = e.point;
      this._overlay.render();
    };

    this._tool.onMouseUp = () => {
      if (this._dragging) {
        this._onChanged();
        this._dragging = null;
      }
    };

    this._tool.activate();

    // paper.Tool has no onDoubleClick — wire the DOM event directly.
    this._onDblClick = (e) => {
      if (this._addon.self.disabled) return;
      const paintLayer = getPaintLayer(paper);
      if (!paintLayer) return;
      const rect = paper.view.element.getBoundingClientRect();
      const viewPt = new paper.Point(e.clientX - rect.left, e.clientY - rect.top);
      const pt = paper.view.viewToProject(viewPt);
      const tol = PIVOT_HIT_PX / paper.view.zoom;
      const groups = paintLayer.getItems({
        match: (i) => i instanceof paper.Group && !i.data?.isHelperItem,
      });
      for (const group of groups) {
        const pivot = findPivotItem(group);
        if (pivot && pt.subtract(pivot.position).length <= tol) {
          deletePivot(group);
          this._onChanged();
          this._overlay.render();
          return;
        }
      }
    };
    paper.view.element.addEventListener("dblclick", this._onDblClick);
  }

  destroy() {
    if (this._onDblClick) {
      this._paper.view.element.removeEventListener("dblclick", this._onDblClick);
      this._onDblClick = null;
    }
    this._tool?.remove();
    this._tool = null;
    this._overlay.setHoverItem(null);
  }
}
