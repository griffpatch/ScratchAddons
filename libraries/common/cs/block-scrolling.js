/**
 * Shared utilities for scrolling Blockly blocks into view with smart positioning.
 * Handles viewport checking, stack alignment, and smooth animations.
 *
 * @module block-scrolling
 */

import { getTopOfStackFor } from "./devtools-utils.js";

/**
 * @typedef {import('blockly').Block} Blockly.Block
 * @typedef {import('blockly').WorkspaceSvg} Blockly.WorkspaceSvg
 */

// Module-level state for smooth scroll animation and UI compensation
let _blocklyInstance = null;
let _smoothScrollAnimator = null;

/**
 * Get the width of the find-bar dropdown if it's visible.
 * This is used to adjust scroll offsets when the dropdown is open.
 *
 * @returns {number} Width in pixels of the visible dropdown, or 0 if not visible
 */
function getFindBarDropdownWidth() {
  const dropdown = document.querySelector(".sa-find-dropdown-out.visible");
  if (!dropdown) return 0;

  // The dropdown has a max-width of 16em, compute actual pixel width
  return dropdown.offsetWidth || 0;
}

/**
 * Initialize the smooth scroll animator with the Blockly instance.
 * Call this once when Blockly is available to enable smooth scrolling.
 *
 * @param {any} blockly - The Blockly instance
 */
export function initializeSmoothScrolling(blockly) {
  _blocklyInstance = blockly;
  // New Blockly (registry-based) has different scrollbar internals - use instant scroll only
  if (!blockly.registry) {
    _smoothScrollAnimator = createSmoothScrollAnimator(blockly);
  }
}

/**
 * Animate scrolling to a specific position using the initialized smooth scroll animator.
 * Falls back to instant scroll if smooth scrolling hasn't been initialized.
 *
 * @param {Blockly.WorkspaceSvg} workspace - The Blockly workspace
 * @param {number} sx - Target scroll X position
 * @param {number} sy - Target scroll Y position
 * @returns {Promise<void>}
 */
export async function animateScrollTo(workspace, sx, sy) {
  if (_smoothScrollAnimator) {
    await _smoothScrollAnimator(workspace, sx, sy);
  } else {
    workspace.scrollbar.set(sx, sy);
  }
}

/**
 * Scroll a block into view if it's not fully visible in the workspace.
 * Uses smart positioning to try to include the top of the stack when reasonable.
 * Automatically uses smooth scrolling if initialized via initializeSmoothScrolling().
 *
 * @param {Blockly.WorkspaceSvg} workspace - The Blockly workspace
 * @param {Blockly.Block} block - The block to scroll to
 * @param {number} [offsetX=32] - X offset margin from viewport edge
 * @param {number} [offsetY=32] - Y offset margin from viewport edge
 * @param {boolean} [instant=false] - If true, skip smooth scrolling animation
 * @returns {Promise<{scrolled: boolean, targetX: number, targetY: number}>} Object with scrolled flag and target positions
 */
export async function scrollBlockIntoViewIfNeeded(workspace, block, offsetX = 32, offsetY = 32, instant = false) {
  if (!workspace || !block) {
    return { scrolled: false, targetX: 0, targetY: 0 };
  }

  // Calculate base and root blocks (always derived the same way)
  const root = block.getRootBlock ? block.getRootBlock() : block;
  const base = getTopOfStackFor(block);

  const ePos = base.getRelativeToSurfaceXY(); // Align with the top of the block
  const rPos = root.getRelativeToSurfaceXY(); // Align with the left of the block 'stack'
  const tPos = block.getRelativeToSurfaceXY(); // Get the actual target block position
  const scale = workspace.scale;
  const blockLeftEdge = rPos.x * scale;
  const blockTopEdge = ePos.y * scale;
  const blockRightEdge = (tPos.x + block.width) * scale; // Use target block's actual position
  const blockBottomEdge = block.height + blockTopEdge;
  const metrics = workspace.getMetrics();

  // Account for find-bar dropdown if visible (takes up space on the left)
  const dropdownWidth = getFindBarDropdownWidth();
  const effectiveOffsetX = offsetX + dropdownWidth;

  // Check if block is outside viewport
  if (
    blockLeftEdge < metrics.viewLeft + effectiveOffsetX - 4 ||
    blockRightEdge > metrics.viewLeft + metrics.viewWidth ||
    blockTopEdge < metrics.viewTop + offsetY - 4 ||
    blockBottomEdge > metrics.viewTop + metrics.viewHeight * 0.7
  ) {
    let targetX = blockLeftEdge - effectiveOffsetX;
    let targetY = blockTopEdge - offsetY;

    // After scrolling, the viewport will be at targetX
    // Account for the margins: the visible content area is smaller than metrics.viewWidth
    const visibleRight = targetX + metrics.viewWidth - offsetX;

    // Check if block's right edge extends beyond visible right edge
    if (blockRightEdge > visibleRight) {
      // Shift viewport right so block's right edge aligns with visible right edge
      targetX = blockRightEdge - metrics.viewWidth + offsetX;
    }

    // Try to include the top of the stack if it's reasonable
    const topBlock = root.getRootBlock ? root.getRootBlock() : root;
    if (topBlock && topBlock !== block) {
      const topPos = topBlock.getRelativeToSurfaceXY();
      const topY = topPos.y * scale;
      const verticalDistance = blockTopEdge - topY;

      // If the top of the stack is within a reasonable distance (less than viewport height)
      // and we can fit both the block and the stack top, adjust the scroll position
      if (verticalDistance > 0 && verticalDistance < metrics.viewHeight * 0.8) {
        // Try to center the range between top of stack and current block
        const midPoint = topY + verticalDistance / 2;
        const idealTopY = midPoint - metrics.viewHeight / 2;

        // Only adjust if it would still keep our target block visible
        if (idealTopY <= topY && idealTopY + metrics.viewHeight - offsetY * 2 >= blockTopEdge) {
          targetY = topY - offsetY;
        }
      }
    }

    // Convert offset to scroll position
    const { sx, sy } = scrollPosFromOffset({ left: targetX, top: targetY }, metrics);

    // Use smooth scroll animation if available and not instant, otherwise instant scroll
    if (_smoothScrollAnimator && !instant) {
      await _smoothScrollAnimator(workspace, sx, sy);
    } else {
      workspace.scrollbar.set(sx, sy);
    }

    return { scrolled: true, targetX: sx, targetY: sy };
  }

  return { scrolled: false, targetX: 0, targetY: 0 };
}

/**
 * Convert viewport offset to scroll position.
 * Handles both old Blockly (contentLeft/contentTop) and new Blockly (scrollLeft/scrollTop).
 *
 * @param {{left: number, top: number}} offset - The target offset position
 * @param {Object} metrics - The workspace metrics
 * @returns {{sx: number, sy: number}} The scroll position
 */
export function scrollPosFromOffset(offset, metrics) {
  // New Blockly uses "scrollLeft" and "scrollTop" instead of "contentLeft" and "contentTop"
  const scrollLeft = metrics.scrollLeft ?? metrics.contentLeft ?? 0;
  const scrollTop = metrics.scrollTop ?? metrics.contentTop ?? 0;

  return {
    sx: offset.left - scrollLeft,
    sy: offset.top - scrollTop,
  };
}

/**
 * Create a smooth scroll animation function that can be passed to scrollBlockIntoViewIfNeeded.
 * This is more advanced and requires Blockly instance for widget management.
 *
 * @param {any} blockly - The Blockly instance (for widget management)
 * @param {number} [duration=300] - Animation duration in milliseconds
 * @returns {Function} Animation function (workspace, sx, sy) => Promise<void>
 */
export function createSmoothScrollAnimator(blockly, duration = 300) {
  let cancelAnimation = null;

  return function animateScroll(workspace, targetSx, targetSy) {
    return new Promise((resolve) => {
      // Cancel any existing animation
      if (cancelAnimation) {
        cancelAnimation();
      }

      let cancelled = false;
      let userInteractionListeners = [];

      const removeUserInteractionListeners = () => {
        userInteractionListeners.forEach(({ element, event, handler }) => {
          element.removeEventListener(event, handler);
        });
        userInteractionListeners = [];
      };

      cancelAnimation = () => {
        cancelled = true;
        cancelAnimation = null;
        removeUserInteractionListeners();
        resolve();
      };

      const scrollbar = workspace.scrollbar;
      const hScroll = scrollbar.hScroll;
      const vScroll = scrollbar.vScroll;

      // Get current handle positions (actual scroll state)
      const startHandleX = hScroll.handlePosition_;
      const startHandleY = vScroll.handlePosition_;

      // Calculate target handle positions using the same ratio conversion
      const targetHandleX = targetSx * hScroll.ratio_;
      const targetHandleY = targetSy * vScroll.ratio_;

      // Calculate the distance to scroll
      const deltaX = targetHandleX - startHandleX;
      const deltaY = targetHandleY - startHandleY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Skip animation if the distance is very small (less than 2 pixels of handle movement)
      if (distance < 2) {
        // Just jump to the target immediately
        hScroll.setHandlePosition(targetHandleX);
        vScroll.setHandlePosition(targetHandleY);
        const metrics = {};
        metrics.x = scrollbar.getRatio_(targetHandleX, hScroll.scrollViewSize_);
        metrics.y = scrollbar.getRatio_(targetHandleY, vScroll.scrollViewSize_);
        workspace.setMetrics(metrics);
        cancelAnimation = null;
        resolve();
        return;
      }

      // Scale duration based on distance (shorter animations for small movements)
      // Min 50ms, max 300ms, scaled by distance
      const scaledDuration = Math.min(300, Math.max(50, duration * (distance / 100)));

      // Listen for user interaction with scrollbars to cancel animation immediately
      const cancelOnUserInteraction = (e) => {
        // Only cancel if the user is actually interacting with scrollbars
        if (
          e.target &&
          (e.target.classList?.contains("blocklyScrollbarHandle") ||
            e.target.classList?.contains("blocklyScrollbarBackground"))
        ) {
          if (cancelAnimation) {
            cancelAnimation();
          }
        }
      };

      // Listen on the scrollbar elements
      const svgGroup = workspace.svgGroup_;
      if (svgGroup) {
        svgGroup.addEventListener("mousedown", cancelOnUserInteraction, true);
        svgGroup.addEventListener("touchstart", cancelOnUserInteraction, true);
        userInteractionListeners.push(
          { element: svgGroup, event: "mousedown", handler: cancelOnUserInteraction },
          { element: svgGroup, event: "touchstart", handler: cancelOnUserInteraction }
        );
      }

      // Hide any open widgets/dropdowns
      if (blockly?.WidgetDiv) {
        blockly.WidgetDiv.hide(true);
      }
      if (blockly?.DropDownDiv) {
        blockly.DropDownDiv.hideWithoutAnimation();
      }

      const startTime = Date.now();

      const animate = () => {
        if (cancelled) {
          return;
        }

        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / scaledDuration, 1);
        const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic

        const currentHandleX = startHandleX + deltaX * ease;
        const currentHandleY = startHandleY + deltaY * ease;

        // Update handle positions
        hScroll.setHandlePosition(currentHandleX);
        vScroll.setHandlePosition(currentHandleY);

        // Update workspace metrics
        const metrics = {};
        metrics.x = scrollbar.getRatio_(currentHandleX, hScroll.scrollViewSize_);
        metrics.y = scrollbar.getRatio_(currentHandleY, vScroll.scrollViewSize_);
        workspace.setMetrics(metrics);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          // Animation complete
          cancelAnimation = null;
          removeUserInteractionListeners();
          resolve();
        }
      };

      animate();
    });
  };
}
