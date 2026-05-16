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

  // Returns the stack's reference corner and opposite edge for column-overlap checks.
  // LTR: pos = top-left, xMax = right edge. RTL: pos = top-right, xMax = left edge.
  const getBlockPosAndXMax = (block) => {
    const { x, y } = block.getRelativeToSurfaceXY();
    const { width } = block.getHeightWidth();
    return block.RTL ? { pos: { x: x + width, y }, xMax: x } : { pos: { x, y }, xMax: x + width };
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

    let { pos: tPos, xMax: tXMax } = getBlockPosAndXMax(root);
    // Blocks injected programmatically start at (0,0) before being positioned;
    // skip the bump at that moment to avoid displacing the top-left script.
    if (tPos.x === 0 && tPos.y === 0) return;

    const isRTL = root.RTL;
    const gap = addon.settings.get("stackGap");

    isBumping = true;
    try {
      // Snap root horizontally to align with the nearest tightly-aligned neighbour.
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

      // Cascade blocks below root downward to restore spacing.
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
        const overlaps = isRTL
          ? tPos.x >= xMax && pos.x >= tXMax
          : tPos.x <= xMax && pos.x <= tXMax;

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

    // When script-snap is active, coordinates start between workspace dots so snap aligns to them
    const startOffset = scriptSnapEnabled ? gridSize / 2 : 0;
    let cursorX = startOffset;

    const maxWidths = result.maxWidths;

    for (const column of columns) {
      let cursorY = startOffset;
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
