//@ts-check

import { getBlockDraggableElement } from "../../libraries/common/cs/block-elements.js";
import { getTopOfStackFor } from "../../libraries/common/cs/devtools-utils.js";
import { scrollBlockIntoViewIfNeeded } from "../../libraries/common/cs/block-scrolling.js";
import { collectTransforms, createTransformedGroup } from "../../libraries/common/cs/svg-utils.js";

/**
 * BlockNavigator handles keyboard navigation through blocks in the workspace
 * with visual highlighting. Activated with Ctrl+Alt+Space.
 */
export default class BlockNavigator {
  /**
   * @param {object} options
   * @param {any} options.addon
   * @param {any} options.console
   * @param {HTMLElement} options.focusTarget
   * @param {any} [options.utils] - Optional Utils instance for smooth scrolling
   */
  constructor({ addon, console, focusTarget, utils }) {
    this.addon = addon;
    this.console = console;
    this.focusTarget = focusTarget;
    this.utils = utils;

    this.navigationMode = false;
    this.navigableElements = [];
    this.elementMetadata = [];
    this.blockElementMap = new Map();
    this.currentNavIndex = -1;
    this.currentOutline = null;
    this.currentFocusedInput = null;
    this.lastNavigationWasBlocksOnly = true;

    // Debug variable - set window.saDebugKeepOutlines = true in console to prevent outline removal
    this.debugKeepOutlines = false;
    Object.defineProperty(window, "saDebugKeepOutlines", {
      get: () => this.debugKeepOutlines,
      set: (value) => {
        this.debugKeepOutlines = value;
        this.console.log("[Navigation] Debug keep outlines:", value);
      },
    });

    this.boundKeyHandler = this.handleKeyDown.bind(this);
    document.addEventListener("keydown", this.boundKeyHandler);
  }

  /**
   * Check if navigation mode is currently active
   */
  isActive() {
    return this.navigationMode;
  }

  /**
   * Collect all navigable elements from the workspace in reading order
   */
  collectNavigableElements() {
    const workspace = this.addon.tab.traps.getWorkspace();
    if (!workspace) {
      this.navigableElements = [];
      this.elementMetadata = [];
      this.blockElementMap = new Map();
      this.console.log("[Navigation] No workspace found");
      return;
    }

    const topLevelBlocks = workspace.getTopBlocks();

    const xTolerance = 40;
    topLevelBlocks.sort((a, b) => {
      const aPos = a.getRelativeToSurfaceXY();
      const bPos = b.getRelativeToSurfaceXY();
      const aX = Math.round(aPos.x / xTolerance) * xTolerance;
      const bX = Math.round(bPos.x / xTolerance) * xTolerance;
      if (aX !== bX) {
        return aX - bX;
      }
      return aPos.y - bPos.y;
    });

    this.navigableElements = [];
    this.elementMetadata = [];
    this.blockElementMap = new Map();

    const traverse = (block, isMainStack) => {
      if (!block) return;

      const blockElement = this.getBlockElement(block);
      if (blockElement) {
        const blockType = typeof block.type === "string" ? block.type : null;
        const blockIsMainStack = isMainStack && !this.shouldSkipMainStackBlock(block);
        this.navigableElements.push(blockElement);
        this.elementMetadata.push({
          kind: "block",
          isMainStack: blockIsMainStack,
          blockId: block.id,
          blockType,
        });
      }

      const inputList = block.inputList || [];
      for (const input of inputList) {
        if (input.fieldRow) {
          for (const field of input.fieldRow) {
            if (!field.fieldGroup_) continue;
            const argGroup = field.fieldGroup_.closest("[data-argument-type]");
            if (!argGroup) continue;
            if (this.navigableElements.includes(argGroup)) continue;
            const argType = argGroup.getAttribute("data-argument-type");
            if (argType && argType !== "dropdown" && argType !== "variable") {
              this.navigableElements.push(argGroup);
              this.elementMetadata.push({
                kind: "input",
                isMainStack: false,
                parentBlockId: block.id,
              });
            }
          }
        }

        if (input.connection && input.connection.targetBlock()) {
          const childBlock = input.connection.targetBlock();
          const childIsMainStack = isMainStack && this.isStatementInput(input, childBlock);
          traverse(childBlock, childIsMainStack);
        }
      }

      const nextBlock = block.getNextBlock();
      if (nextBlock) {
        traverse(nextBlock, isMainStack);
      }
    };

    for (const topLevelBlock of topLevelBlocks) {
      traverse(topLevelBlock, true);
    }

    this.console.log("[Navigation] Collected", this.navigableElements.length, "navigable elements");
  }

  /**
   * Update the visual highlight and focus for the current navigation position
   */
  updateCaretPosition() {
    if (this.currentOutline && !this.debugKeepOutlines) {
      this.currentOutline.remove();
      this.currentOutline = null;
    }

    if (this.currentFocusedInput) {
      if (typeof this.currentFocusedInput.blur === "function") {
        try {
          this.currentFocusedInput.blur();
        } catch (err) {
          this.console.log("[Navigation] Failed to blur previous focus", err);
        }
      }
      this.currentFocusedInput = null;
    }

    if (this.currentNavIndex < 0 || this.currentNavIndex >= this.navigableElements.length) {
      return;
    }

    const targetElement = this.navigableElements[this.currentNavIndex];
    const metadata = this.elementMetadata[this.currentNavIndex] || { kind: null, isMainStack: false };

    let outlineTarget = null;
    if (metadata.kind === "block") {
      outlineTarget = targetElement;
    } else if (metadata.kind === "input" && metadata.parentBlockId) {
      outlineTarget = this.getBlockElementById(metadata.parentBlockId);
    }

    if (outlineTarget) {
      this.currentOutline = this.drawBlockOutline(outlineTarget, this.currentNavIndex);
    }

    let focusTarget = null;
    if (metadata.kind === "input") {
      focusTarget = this.getFocusableDescendant(targetElement);
    } else if (!this.lastNavigationWasBlocksOnly) {
      focusTarget = this.getFocusableDescendant(targetElement);
    }

    if (focusTarget && typeof focusTarget.focus === "function") {
      try {
        focusTarget.focus();
        this.currentFocusedInput = focusTarget;
      } catch (err) {
        this.console.log("[Navigation] Failed to focus element", err);
      }
    }

    // Scroll into view if needed
    if (this.utils && metadata.kind === "block" && metadata.blockId) {
      this.scrollBlockIntoViewIfNeeded(metadata.blockId);
    }
  }

  /**
   * Start navigation mode
   */
  start() {
    if (this.addon.tab.editorMode !== "editor") {
      this.console.log("[Navigation] Not in editor mode, skipping");
      return;
    }
    this.collectNavigableElements();
    if (this.navigableElements.length > 0) {
      this.navigationMode = true;
      this.currentNavIndex = 0;
      this.lastNavigationWasBlocksOnly = true;
      this.updateCaretPosition();
      this.console.log("[Navigation] Started navigation mode");
    } else {
      this.console.log("[Navigation] No navigable elements found");
    }
  }

  /**
   * Exit navigation mode
   */
  exit() {
    this.navigationMode = false;
    this.currentNavIndex = -1;
    this.updateCaretPosition();
    if (this.focusTarget) {
      this.focusTarget.focus();
    }
    this.console.log("[Navigation] Exited navigation mode");
  }

  /**
   * Navigate to the next element
   * @param {boolean} mainStackOnly
   */
  navigateToNext(mainStackOnly = false) {
    this._navigate(1, mainStackOnly);
  }

  /**
   * Navigate to the previous element
   * @param {boolean} mainStackOnly
   */
  navigateToPrev(mainStackOnly = false) {
    this._navigate(-1, mainStackOnly);
  }

  /**
   * Internal navigation helper
   * @param {number} direction - 1 for next, -1 for previous
   * @param {boolean} mainStackOnly
   * @private
   */
  _navigate(direction, mainStackOnly) {
    if (!this.navigationMode || this.navigableElements.length === 0) {
      this.console.log("[Navigation] Not in navigation mode or no elements");
      return;
    }

    this.lastNavigationWasBlocksOnly = mainStackOnly;

    const total = this.navigableElements.length;
    let currentIndex = this.currentNavIndex;
    let attempts = 0;

    do {
      currentIndex = (currentIndex + direction + total) % total;
      attempts++;

      const metadata = this.elementMetadata[currentIndex];
      if (mainStackOnly) {
        if (!metadata || metadata.kind !== "block" || !metadata.isMainStack) {
          continue;
        }
      }

      this.currentNavIndex = currentIndex;
      this.updateCaretPosition();
      this.console.log("[Navigation] Moved to element:", this.currentNavIndex + 1);
      return;
    } while (attempts < total);

    this.console.log("[Navigation] No valid element found");
  }

  /**
   * Handle keyboard events for navigation
   * @param {KeyboardEvent} e
   */
  handleKeyDown(e) {
    if (e.key === " " && (e.ctrlKey || e.metaKey) && e.altKey) {
      this.console.log("[Navigation] Ctrl+Alt+Space pressed - starting navigation");
      this.start();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!this.navigationMode) return;

    switch (e.key) {
      case "ArrowRight":
        this.navigateToNext(false);
        e.preventDefault();
        e.stopPropagation();
        break;
      case "ArrowDown":
        this.navigateToNext(true);
        e.preventDefault();
        e.stopPropagation();
        break;
      case "ArrowLeft":
        this.navigateToPrev(false);
        e.preventDefault();
        e.stopPropagation();
        break;
      case "ArrowUp":
        this.navigateToPrev(true);
        e.preventDefault();
        e.stopPropagation();
        break;
      case "Escape":
        this.exit();
        e.preventDefault();
        e.stopPropagation();
        break;
      case "Enter":
        break;
    }
  }

  /**
   * Determine if a block should be skipped during main-stack navigation
   * @param {any} block
   * @returns {boolean}
   */
  shouldSkipMainStackBlock(block) {
    if (!block || typeof block.type !== "string") {
      return false;
    }

    const type = block.type;
    return type === "procedures_prototype";
  }

  /**
   * Get (and cache) the draggable element for a block
   * @param {any} block
   * @returns {SVGGElement|null}
   */
  getBlockElement(block) {
    if (!block) return null;
    const cached = this.blockElementMap.get(block.id);
    if (cached) return cached;

    const blockElement = getBlockDraggableElement(block);

    if (!blockElement) {
      this.console.log("[Navigation] No SVG root for block:", block.type, "ID:", block.id);
      return null;
    }

    this.blockElementMap.set(block.id, blockElement);
    return blockElement;
  }

  /**
   * Determine whether the input represents a statement (substack) connection
   * @param {any} input
   * @param {any} childBlock
   * @returns {boolean}
   */
  isStatementInput(input, childBlock) {
    if (!input || !input.connection) {
      return false;
    }

    if (childBlock) {
      const childType = typeof childBlock.type === "string" ? childBlock.type : "";
      if (childType === "procedures_prototype") {
        return false;
      }
    }

    if (childBlock && childBlock.previousConnection && !childBlock.outputConnection) {
      return true;
    }

    return false;
  }

  /**
   * Resolve a block element by id, consulting the cache first
   * @param {string} blockId
   * @returns {SVGGElement|null}
   */
  getBlockElementById(blockId) {
    if (!blockId) return null;
    if (this.blockElementMap.has(blockId)) {
      return this.blockElementMap.get(blockId) || null;
    }

    const workspace = this.addon.tab.traps.getWorkspace();
    if (!workspace || typeof workspace.getBlockById !== "function") {
      return null;
    }

    const block = workspace.getBlockById(blockId);
    if (!block) {
      return null;
    }

    return this.getBlockElement(block);
  }

  /**
   * Find a focusable descendant within an element
   * @param {HTMLElement} element
   * @returns {HTMLElement|null}
   */
  getFocusableDescendant(element) {
    if (!element) return null;

    const directInput = element.querySelector("input, textarea, select, button");
    if (directInput) {
      return /** @type {HTMLElement} */ (directInput);
    }

    const editableGroup = element.querySelector(".blocklyEditableText");
    if (editableGroup) {
      const groupElement = /** @type {HTMLElement} */ (editableGroup);
      const nestedInput = groupElement.querySelector("input, textarea, select");
      if (nestedInput) {
        return /** @type {HTMLElement} */ (nestedInput);
      }
      if (typeof groupElement.focus === "function") {
        return groupElement;
      }
    }

    if (typeof element.focus === "function") {
      return element;
    }

    return null;
  }

  /**
   * Scroll a block into view if it's not fully visible (uses smooth animation if utils available)
   * @param {string} blockId
   */
  async scrollBlockIntoViewIfNeeded(blockId) {
    const workspace = this.addon.tab.traps.getWorkspace();
    if (!workspace) return;

    const block = workspace.getBlockById(blockId);
    if (!block) return;

    // Use shared scrolling utility (automatically uses smooth animation if initialized)
    await scrollBlockIntoViewIfNeeded(workspace, block);
  }

  /**
   * Find the top stack block of a stack (used for scrolling alignment)
   * @param {any} block
   * @returns {any}
   */
  getTopOfStackFor(block) {
    return getTopOfStackFor(block);
  }

  /**
   * Draw an outline for the supplied block element
   * @param {HTMLElement} blockElement
   * @param {number} outlineIndex
   * @returns {SVGGElement|null}
   */
  drawBlockOutline(blockElement, outlineIndex) {
    if (!blockElement) {
      return null;
    }

    const blockPath = blockElement.querySelector(".blocklyPath");
    if (!blockPath) {
      this.console.log("[Navigation] Could not find block path for outline");
      return null;
    }

    const blockCanvas = blockPath.closest(".blocklyBlockCanvas");
    if (!blockCanvas) {
      this.console.log("[Navigation] Could not find block canvas for outline");
      return null;
    }

    // Use shared utility to collect transforms and create group
    const transforms = collectTransforms(blockPath, blockCanvas);
    const outlineGroup = createTransformedGroup(transforms, "sa-navigation-outline");
    outlineGroup.setAttribute("id", "sa-nav-outline-" + outlineIndex);

    const outlinePath = /** @type {SVGPathElement} */ (blockPath.cloneNode(true));
    outlinePath.setAttribute("class", "sa-navigation-outline-path");
    outlinePath.setAttribute("fill", "none");
    outlinePath.setAttribute("stroke", "#000000");
    outlinePath.setAttribute("stroke-width", "3");
    outlinePath.style.filter = "drop-shadow(0 0 4px rgba(0,0,0,0.5))";
    outlineGroup.appendChild(outlinePath);

    const existing = blockCanvas.querySelector("#sa-nav-outline-" + outlineIndex);
    if (existing) {
      existing.remove();
    }

    blockCanvas.appendChild(outlineGroup);
    return outlineGroup;
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    document.removeEventListener("keydown", this.boundKeyHandler);
    if (this.currentOutline) {
      this.currentOutline.remove();
      this.currentOutline = null;
    }
  }
}
