import BlockInstance from "./BlockInstance.js";
import BlockFlasher from "./BlockFlasher.js";
import { getTopOfStackFor } from "../../../libraries/common/cs/devtools-utils.js";
import * as BlockScrolling from "../../../libraries/common/cs/block-scrolling.js";

// Make these global so that every addon uses the same arrays.
let views = [];
let forward = [];
export default class Utils {
  constructor(addon) {
    this.addon = addon;
    this.addon.tab.traps.getBlockly().then((blockly) => {
      this.blockly = blockly;
      // Initialize smooth scrolling in the block-scrolling module
      BlockScrolling.initializeSmoothScrolling(blockly);
    });
    /**
     * Scratch Virtual Machine
     * @type {null|*}
     */
    this.vm = this.addon.tab.traps.vm;
    // this._myFlash = { block: null, timerID: null, colour: null };
    this.navigationHistory = new NavigationHistory(this.addon, this);

    // Offset constants for block scrolling (dropdown width is added automatically by block-scrolling.js)
    this.offsetX = 32;
    this.offsetY = 48;
  }

  /**
   * Get the ID from a block object, whether it's a Blockly block or BlockInstance
   * @param {Object} block - Block object (Blockly.Block or BlockInstance)
   * @returns {string|null} Block ID or null
   */
  getBlockId(block) {
    if (!block) return null;
    return block.id || (block.getId ? block.getId() : null);
  }

  /**
   * Get the Scratch Editing Target
   * @returns {?Target} the scratch editing target
   */
  getEditingTarget() {
    return this.vm.runtime.getEditingTarget();
  }

  /**
   * Set the current workspace (switches sprites)
   * @param targetID {string}
   */
  setEditingTarget(targetID) {
    if (this.getEditingTarget().id !== targetID) {
      this.vm.setEditingTarget(targetID);
    }
  }

  /**
   * Based on wksp.centerOnBlock(li.data.labelID);
   * @param blockOrId {Blockly.Block|{id}|BlockInstance} A Blockly Block, a block id, or a BlockInstance
   * @param instant {boolean} If true, skip smooth scrolling animation
   * @param onSpriteSwitch {Function} Optional callback called after sprite switch completes
   */
  async scrollBlockIntoView(blockOrId, instant = false, onSpriteSwitch = null) {
    /** @type {Blockly.Block} */
    let block; // or is it really a Blockly.BlockSvg?
    let didSpriteSwitch;

    if (blockOrId instanceof BlockInstance) {
      // Check if we're actually switching sprites
      const currentTargetId = this.getEditingTarget().id;
      didSpriteSwitch = blockOrId.targetId !== currentTargetId;

      if (this._cancelAnimation) {
        this._cancelAnimation();
        // Wait a bit for the cancellation to complete
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      if (didSpriteSwitch) {
        // Switch to sprite
        this.setEditingTarget(blockOrId.targetId);
        // Wait for workspace to update after sprite switch
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Get the workspace after switching
      let workspace = this.addon.tab.traps.getWorkspace();
      if (!workspace) {
        console.warn("Workspace not available after sprite switch", blockOrId);
        return;
      }
      // Highlight the block!
      block = workspace.getBlockById(blockOrId.id);
      // Force instant scroll when switching sprites
      if (didSpriteSwitch) {
        instant = true;
      }

      // Call sprite switch callback only if we actually switched
      if (didSpriteSwitch && onSpriteSwitch) {
        onSpriteSwitch();
      }
    } else {
      let workspace = this.addon.tab.traps.getWorkspace();
      if (!workspace) {
        console.warn("Workspace not available", blockOrId);
        return;
      }
      block = blockOrId && blockOrId.id ? blockOrId : workspace.getBlockById(blockOrId);
    }

    if (!block) {
      console.warn("Block not found", blockOrId);
      return;
    }

    // Get workspace again to ensure it's current
    let workspace = this.addon.tab.traps.getWorkspace();

    const scrolled = await this.scrollBlockIntoViewIfNeeded(workspace, block, instant);

    if (scrolled) {
      this.blockly?.hideChaff();
    }

    // Delay flash effects until after scroll animation completes
    setTimeout(
      () => {
        // BlockFlasher.flash(block);
        BlockFlasher.selectionEffect(block);
      },
      scrolled ? 50 : 0
    );
  }

  /**
   * Scroll a block into view if it's not fully visible
   * @param {any} workspace - Blockly workspace
   * @param {any} block - The block to scroll to
   * @param {boolean} instant - If true, skip smooth scrolling animation
   * @returns {Promise<boolean>} - True if scrolling occurred
   */
  async scrollBlockIntoViewIfNeeded(workspace, block, instant = false) {
    // Store view before scrolling
    this.navigationHistory.storeView(this.navigationHistory.peek(), 64);

    // Cancel any pending user scroll tracking before programmatic scroll
    this.navigationHistory.cancelPendingScrollTracking();

    // Use shared scrolling utility (automatically uses smooth animation if initialized)
    // Set isOurScroll flag to prevent the scroll hook from recording this programmatic scroll
    this.navigationHistory.isOurScroll = true;
    try {
      const result = await BlockScrolling.scrollBlockIntoViewIfNeeded(
        workspace,
        block,
        this.offsetX,
        this.offsetY,
        instant
      );

      // Store view after scrolling
      if (result.scrolled) {
        // this.navigationHistory.storeView({ left: result.targetX, top: result.targetY }, 64);
        this.navigationHistory.storeView(this.navigationHistory.peek(), 64);
      }

      return result.scrolled;
    } finally {
      this.navigationHistory.isOurScroll = false;
    }
  }
}

class NavigationHistory {
  constructor(addon, utils) {
    this.addon = addon;
    /** @type {Utils} */
    this.utils = utils;
    this.userScrollDebounceTimer = null;
    this.isOurScroll = false; // Flag to prevent recording our own smooth scrolls

    // Set up listener for workspace scroll events (delayed until workspace is available)
    setTimeout(() => {
      try {
        const workspace = this.addon.tab.traps.getWorkspace();
        if (workspace) {
          this.setupScrollListener(workspace);
        }
      } catch (e) {
        // Workspace not available yet, ignore
      }
    }, 1000);
  }

  /**
   * Cancel any pending scroll tracking (called before programmatic scrolls)
   */
  cancelPendingScrollTracking() {
    if (this.userScrollDebounceTimer) {
      clearTimeout(this.userScrollDebounceTimer);
      this.userScrollDebounceTimer = null;
    }
  }

  /**
   * Set up a listener to track user-initiated scrolls so that we can record them
   * in the navigation history when we stop scrolling.
   * @param {any} workspace - Blockly workspace
   */
  setupScrollListener(workspace) {
    // Only set up once - check if we've already hooked this workspace
    if (workspace._saScrollListenerInstalled) {
      return;
    }
    workspace._saScrollListenerInstalled = true;

    let isScrolling = false;
    let scrollResetTimer = null;

    // Hook into scrollbar set method to detect manual scrolling
    if (workspace.scrollbar) {
      const originalSet = workspace.scrollbar.set;

      workspace.scrollbar.set = (...args) => {
        // Skip recording if this is our own smooth scroll
        if (this.isOurScroll) {
          return originalSet.apply(workspace.scrollbar, args);
        }

        // Record position at start of scroll interaction
        if (!isScrolling) {
          this.recordCurrentPosition(workspace);
          isScrolling = true;
        }

        // Clear any existing reset timer
        if (scrollResetTimer) {
          clearTimeout(scrollResetTimer);
        }

        this.handleUserScroll(workspace, () => {
          // Reset flag after scrolling completes and debounce timer fires
          scrollResetTimer = setTimeout(() => {
            isScrolling = false;
            scrollResetTimer = null;
          }, 100);
        });
        return originalSet.apply(workspace.scrollbar, args);
      };
    }

    // Listen to block drag events to record position at start of drag
    const originalStartDrag = workspace.startDrag;
    if (originalStartDrag) {
      workspace.startDrag = (...args) => {
        this.recordCurrentPosition(workspace);
        return originalStartDrag.apply(workspace, args);
      };
    }
  }

  /**
   * Handle user scroll with debouncing
   * @param {any} workspace
   * @param {Function} [onComplete] - Callback when debounce timer completes
   */
  handleUserScroll(workspace, onComplete) {
    // Clear existing timer
    if (this.userScrollDebounceTimer) {
      clearTimeout(this.userScrollDebounceTimer);
      this.userScrollDebounceTimer = null;
    }

    // Capture the current position now to check later
    const metrics = workspace.getMetrics();
    const startPos = { left: metrics.viewLeft, top: metrics.viewTop };

    // Set new timer for 1.5 seconds
    this.userScrollDebounceTimer = setTimeout(() => {
      // Get the final position
      const finalMetrics = workspace.getMetrics();
      const finalPos = { left: finalMetrics.viewLeft, top: finalMetrics.viewTop };

      // Only record if position actually changed from start
      const dist = distance(startPos, finalPos);

      if (dist > 10) {
        // Moved at least 10 pixels during the pause
        this.recordCurrentPosition(workspace);
      }

      this.userScrollDebounceTimer = null;
      if (onComplete) onComplete();
    }, 1500);
  }

  /**
   * Record the current viewport position if it's different from the last recorded
   * @param {any} workspace
   */
  recordCurrentPosition(workspace) {
    const lastInHistory = views.length > 0 ? views[views.length - 1] : null;
    this.storeView(lastInHistory, 64);
  }

  /**
   * Clear all navigation history (e.g., when switching sprites)
   */
  clearHistory() {
    views = [];
    forward = [];
  }

  scrollPosFromOffset(offset, metrics) {
    // Use shared utility function
    return BlockScrolling.scrollPosFromOffset(offset, metrics);
  }

  /**
   * Keep a record of the scroll and zoom position
   * @param {Object} next - Position to compare against, or null to always record
   * @param {number} dist - Minimum distance threshold
   */
  storeView(next, dist) {
    let workspace = this.addon.tab.traps.getWorkspace(),
      s = workspace.getMetrics();

    let pos = { left: s.viewLeft, top: s.viewTop };
    if (!next || distance(pos, next) > dist) {
      forward = [];
      views.push(pos);
    }
  }

  peek() {
    return views.length > 0 ? views[views.length - 1] : null;
  }

  async goBack() {
    const workspace = this.addon.tab.traps.getWorkspace(),
      s = workspace.getMetrics();

    let pos = { left: s.viewLeft, top: s.viewTop };
    let view = this.peek();
    if (!view) {
      return;
    }

    // If we're far from the last history item, record current position first
    if (distance(pos, view) > 64) {
      views.push({ left: pos.left, top: pos.top });
    }

    // Now go back
    if (views.length > 1) {
      const current = views.pop();
      forward.push(current);
    }

    view = this.peek();
    if (!view) {
      return;
    }

    let { sx, sy } = this.scrollPosFromOffset(view, s);

    // Cancel any pending user scroll tracking
    this.cancelPendingScrollTracking();

    // Use shared smooth scrolling
    this.isOurScroll = true;
    await BlockScrolling.animateScrollTo(workspace, sx, sy);
    this.isOurScroll = false;
  }

  async goForward() {
    let view = forward.pop();
    if (!view) {
      return;
    }
    views.push(view);

    let workspace = this.addon.tab.traps.getWorkspace(),
      s = workspace.getMetrics();

    let { sx, sy } = this.scrollPosFromOffset(view, s);

    // Cancel any pending user scroll tracking
    this.cancelPendingScrollTracking();

    // Use shared smooth scrolling
    this.isOurScroll = true;
    await BlockScrolling.animateScrollTo(workspace, sx, sy);
    this.isOurScroll = false;
  }
}

function distance(pos, next) {
  return Math.sqrt(Math.pow(pos.left - next.left, 2) + Math.pow(pos.top - next.top, 2));
}
