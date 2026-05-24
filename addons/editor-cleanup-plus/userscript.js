import UndoGroup from "../../libraries/common/cs/UndoGroup.js";
import {
  getVariableUsesById,
  getOrderedTopBlockColumns,
  autoPositionComment,
  COLUMN_GROUP_TOLERANCE,
} from "../../libraries/common/cs/devtools-utils.js";

// Gap between stacks when script-snap is not active (not constrained to grid size)
const NON_SNAP_GAP = 50;

export default async function ({ addon, console, msg, safeMsg: m }) {
  const blockly = await addon.tab.traps.getBlockly();

  const isScriptSnapEnabled = async () => {
    const enabledAddons = await addon.self.getEnabledAddons();
    return enabledAddons.includes("script-snap");
  };

  // Blockly's built-in cleanup menu item requires >1 top block. Override the precondition
  // so the item is always available whenever the workspace is movable (even with 0–1 blocks).
  if (blockly.ContextMenuRegistry) {
    const cleanItem = blockly.ContextMenuRegistry.registry.getItem("cleanWorkspace");
    if (cleanItem) {
      const origPrecondition = cleanItem.preconditionFn;
      const patchedPrecondition = (scope) => (scope.workspace?.isMovable() ? "enabled" : "hidden");
      cleanItem.preconditionFn = patchedPrecondition;
      addon.self.addEventListener("disabled", () => (cleanItem.preconditionFn = origPrecondition));
      addon.self.addEventListener("reenabled", () => (cleanItem.preconditionFn = patchedPrecondition));
    }
  }

  // Returns the stack's reference corner and opposite edge for column-overlap checks.
  // LTR: pos = top-left, xMax = right edge. RTL: pos = top-right, xMax = left edge.
  const getBlockPosAndXMax = (block) => {
    const { x, y } = block.getRelativeToSurfaceXY();
    const { width } = block.getHeightWidth();
    return block.RTL ? { pos: { x: x + width, y }, xMax: x } : { pos: { x, y }, xMax: x + width };
  };

  // Track blocks that were just created (from flyout or programmatically). bumpNeighbours
  // fires on a new block before it has been positioned, so we must skip it for that first
  // synchronous call, then allow the subsequent call once the block is at its real position.
  const justCreatedBlocks = new Set();
  const origInitSvg = blockly.BlockSvg.prototype.initSvg;
  blockly.BlockSvg.prototype.initSvg = function (...args) {
    justCreatedBlocks.add(this.id);
    requestAnimationFrame(() => justCreatedBlocks.delete(this.id));
    return origInitSvg.apply(this, args);
  };

  // Patch bumpNeighbours so that when live cleanup is enabled, instead of Blockly's
  // arbitrary-direction bumping we push stacks in the same column downward to restore spacing.
  let isBumping = false;
  const bumpMethod = blockly.registry ? "bumpNeighbours" : "bumpNeighbours_";
  const origBump = blockly.BlockSvg.prototype[bumpMethod];
  blockly.BlockSvg.prototype[bumpMethod] = function () {
    if (isBumping) return;
    if (addon.self.disabled || !addon.settings.get("liveCleanup")) {
      return origBump.call(this);
    }

    const root = this.getRootBlock();
    const wksp = root.workspace;
    if (!wksp || wksp.isFlyout || wksp.isDragging()) return;
    // Only push for hat/statement blocks (no output). Reporters and booleans have an
    // outputConnection and float freely — pushing for them would be too disruptive.
    if (root.outputConnection) return;
    // Skip blocks that were just created and haven't been positioned yet — they start at
    // (0,0) before being placed, which would incorrectly displace the top-left script.
    if (justCreatedBlocks.has(root.id)) return;

    let { pos: tPos, xMax: tXMax } = getBlockPosAndXMax(root);

    const isRTL = root.RTL;
    const gap = addon.settings.get("stackGap");

    isBumping = true;
    try {
      // Phase 1: Snap root horizontally to align with the nearest tightly-aligned neighbour.
      // If a top block's left edge is within 30px left / 50px right of root's left edge,
      // snap root to it so columns stay crisp.
      const rootLeft = isRTL ? tXMax : tPos.x;
      let snapTarget = null;
      let snapDist = Infinity;
      for (const b of wksp.getTopBlocks()) {
        if (b === root) continue;
        const { pos: bPos, xMax: bXMax } = getBlockPosAndXMax(b);
        const bLeft = isRTL ? bXMax : bPos.x;
        const leftOffset = bLeft - rootLeft;
        if (leftOffset !== 0 && leftOffset >= -30 && leftOffset <= 50) {
          const yDist = Math.abs(bPos.y - tPos.y);
          if (yDist < snapDist) {
            snapDist = yDist;
            snapTarget = bLeft;
          }
        }
      }
      if (snapTarget !== null) {
        root.moveBy(snapTarget - rootLeft, 0);
        ({ pos: tPos, xMax: tXMax } = getBlockPosAndXMax(root));
      }

      // Phase 2: Push root itself down if it's too close to a stack above it in the same
      // column. bumpNeighbours is called on the block that should move away (root), so we
      // need to push it down to restore spacing below whichever stack above it just grew.
      {
        const rLeft = isRTL ? tXMax : tPos.x;
        let closestAboveBottom = -Infinity;
        for (const b of wksp.getTopBlocks()) {
          if (b === root) continue;
          const { pos: bPos, xMax: bXMax } = getBlockPosAndXMax(b);
          const bLeft = isRTL ? bXMax : bPos.x;
          const leftOffset = bLeft - rLeft;
          if (leftOffset < -30 || leftOffset > 50) continue; // different column
          if (bPos.y >= tPos.y) continue; // at or below root — skip
          const bBottom = bPos.y + b.getHeightWidth().height;
          if (bBottom > closestAboveBottom) closestAboveBottom = bBottom;
        }
        if (closestAboveBottom !== -Infinity) {
          const delta = closestAboveBottom + gap - tPos.y;
          if (delta > 0) {
            root.moveBy(0, delta);
            ({ pos: tPos, xMax: tXMax } = getBlockPosAndXMax(root));
          }
        }
      }

      // Phase 3: Cascade blocks below root downward to restore spacing.
      const tBottom = tPos.y + root.getHeightWidth().height;

      const columnBlocks = wksp
        .getTopBlocks()
        .filter((b) => {
          if (b === root) return false;
          const { pos } = getBlockPosAndXMax(b);
          return pos.y >= tPos.y;
        })
        .sort((a, b) => {
          const { pos: pa } = getBlockPosAndXMax(a);
          const { pos: pb } = getBlockPosAndXMax(b);
          return pa.y - pb.y;
        });

      let floor = tBottom + gap;
      let lastShift = 0;
      for (const block of columnBlocks) {
        const { pos, xMax } = getBlockPosAndXMax(block);

        // Outer guard: if the block's X span doesn't overlap the column at all, skip it —
        // it's in a different column and we should never touch it.
        const overlaps = isRTL ? tPos.x >= xMax && pos.x >= tXMax : tPos.x <= xMax && pos.x <= tXMax;

        // Tight column: the block's left edge is closely aligned with root's left edge
        // (within 30px to the left or 50px to the right). Only these blocks advance the floor.
        const blockLeft = isRTL ? xMax : pos.x;
        const leftOffset = blockLeft - (isRTL ? tXMax : tPos.x);
        const tightColumn = leftOffset >= -30 && leftOffset <= 50;

        if (!tightColumn && !overlaps) continue; // clearly a different column — leave it alone

        if (block.outputConnection || !tightColumn) {
          // Reporters, booleans, and loosely-aligned stacks: keep in step with the
          // last tight-column shift so they stay in relative position.
          if (lastShift > 0) block.moveBy(0, lastShift);
        } else {
          // Tightly-aligned hat/statement block: push to floor and advance it.
          const delta = floor - pos.y;
          if (delta > 0) {
            block.moveBy(0, delta);
            lastShift = delta;
          } else {
            lastShift = 0;
          }
          floor = Math.max(pos.y, floor) + block.getHeightWidth().height + gap;
        }
      }
    } finally {
      isBumping = false;
    }
  };

  const originalMsg = blockly.Msg.CLEAN_UP;
  addon.self.addEventListener("disabled", () => (blockly.Msg.CLEAN_UP = originalMsg));
  addon.self.addEventListener("reenabled", () => (blockly.Msg.CLEAN_UP = m("clean-plus")));
  blockly.Msg.CLEAN_UP = m("clean-plus");

  const oldCleanUpFunc = blockly.WorkspaceSvg.prototype.cleanUp;
  blockly.WorkspaceSvg.prototype.cleanUp = function () {
    if (addon.self.disabled) return oldCleanUpFunc.call(this);
    void doCleanUp();
  };

  const doCleanUp = async () => {
    const workspace = addon.tab.traps.getWorkspace();
    const promptUnused = addon.settings.get("promptUnused");
    const scriptSnapEnabled = await isScriptSnapEnabled();

    UndoGroup.startUndoGroup(workspace);

    const result = getOrderedTopBlockColumns(true, workspace);
    const columns = result.cols;
    const orphanCount = result.orphans.blocks.length;
    if (orphanCount > 0) {
      const message = msg("orphaned", {
        count: orphanCount,
      });
      if (promptUnused && confirm(message)) {
        for (const block of result.orphans.blocks) {
          block.dispose();
        }
      } else {
        columns.unshift(result.orphans);
      }
    }

    const gridSize = workspace.getGrid().spacing || workspace.getGrid().spacing_; // new blockly || old blockly
    const gap = addon.settings.get("stackGap");
    // Horizontal gap between columns: at least 64px regardless of the stackGap setting.
    const hGap = Math.max(gap, 64);

    // Leave a margin from the workspace origin so blocks don't sit flush against the edge.
    // When script-snap is active, snap the margin up to the nearest grid-aligned position
    // (i.e. a multiple of gridSize offset by gridSize/2) so the first block still snaps cleanly.
    const MARGIN = 64;
    const snapOffset = scriptSnapEnabled ? gridSize / 2 : 0;
    const cursorStart = scriptSnapEnabled
      ? Math.ceil((MARGIN - snapOffset) / gridSize) * gridSize + snapOffset
      : MARGIN;
    let cursorX = cursorStart;

    const maxWidths = result.maxWidths;

    for (const column of columns) {
      let cursorY = cursorStart;
      let maxWidth = 0;

      for (const block of column.blocks) {
        const xy = block.getRelativeToSurfaceXY();
        if (cursorX - xy.x !== 0 || cursorY - xy.y !== 0) {
          block.moveBy(cursorX - xy.x, cursorY - xy.y);
        }
        const heightWidth = block.getHeightWidth();
        cursorY += heightWidth.height + gap;
        // Only snap-round cursor positions when script-snap is active; otherwise gaps become grid-size multiples.
        if (scriptSnapEnabled) {
          cursorY += gridSize - ((cursorY + gridSize / 2) % gridSize);
        }

        const maxWidthWithComments = maxWidths[block.id] || 0;
        maxWidth = Math.max(maxWidth, Math.max(heightWidth.width, maxWidthWithComments));
      }

      // Advance by at least COLUMN_GROUP_TOLERANCE so adjacent column left-edges are always
      // far enough apart that a second cleanup won't merge them into one column.
      cursorX += Math.max(maxWidth + hGap, COLUMN_GROUP_TOLERANCE);
      if (scriptSnapEnabled) {
        cursorX += gridSize - ((cursorX + gridSize / 2) % gridSize);
      }
    }

    const topComments = workspace.getTopComments();
    for (const comment of topComments) {
      autoPositionComment(comment);
    }

    setTimeout(() => {
      if (promptUnused) promptUnusedVariables();
      UndoGroup.endUndoGroup(workspace);
    }, 100);
  };

  function promptUnusedVariables() {
    // Locate unused local variables...
    const workspace = addon.tab.traps.getWorkspace();
    const map = workspace.getVariableMap();
    const vars = map.getVariablesOfType("");
    const unusedLocals = [];

    for (const row of vars) {
      if (row.isLocal) {
        const usages = getVariableUsesById(row.getId(), workspace);
        if (!usages || usages.length === 0) {
          unusedLocals.push(row);
        }
      }
    }

    if (unusedLocals.length > 0) {
      const message = msg("unused-var", {
        count: unusedLocals.length,
        names: unusedLocals.map((x) => x.name).join(", "),
      });
      if (confirm(message)) {
        for (const orphan of unusedLocals) {
          if (blockly.registry) {
            // new Blockly
            workspace.getVariableMap().deleteVariable(orphan);
          } else {
            workspace.deleteVariableById(orphan.getId());
          }
        }
      }
    }

    // Locate unused local lists...
    const lists = map.getVariablesOfType("list");
    let unusedLists = [];

    for (const row of lists) {
      if (row.isLocal) {
        const usages = getVariableUsesById(row.getId(), workspace);
        if (!usages || usages.length === 0) {
          unusedLists.push(row);
        }
      }
    }
    if (unusedLists.length > 0) {
      let message = msg("unused-list", {
        count: unusedLists.length,
        names: unusedLists.map((x) => x.name).join(", "),
      });
      if (confirm(message)) {
        for (const orphan of unusedLists) {
          if (blockly.registry) {
            // new Blockly
            workspace.getVariableMap().deleteVariable(orphan);
          } else {
            workspace.deleteVariableById(orphan.getId());
          }
        }
      }
    }
  }
}
