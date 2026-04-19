/**
 * Shared utilities for working with Blockly block SVG elements.
 * Handles compatibility between old and new Blockly versions.
 *
 * @module block-elements
 */

/**
 * @typedef {import('blockly').Block} Blockly.Block
 */

/**
 * Get the SVG root element for a block.
 * Handles both new Blockly (getSvgRoot method) and old Blockly (svgGroup_ property).
 *
 * @param {Blockly.Block} block - The Blockly block
 * @returns {SVGGElement|null} The SVG root element, or null if not found
 */
export function getBlockSvgRoot(block) {
  if (!block) return null;

  // New Blockly: use getSvgRoot() method
  if (typeof block.getSvgRoot === "function") {
    return block.getSvgRoot();
  }

  // Old Blockly: fallback to svgGroup_ property
  return block.svgGroup_ || null;
}

/**
 * Get the draggable SVG element for a block.
 * This is the element with the .blocklyDraggable class that represents the visual block.
 *
 * @param {Blockly.Block} block - The Blockly block
 * @returns {SVGGElement|null} The draggable SVG element, or null if not found
 */
export function getBlockDraggableElement(block) {
  const svgRoot = getBlockSvgRoot(block);
  if (!svgRoot) return null;

  // Check if the root itself is the draggable element
  if (svgRoot.classList?.contains("blocklyDraggable")) {
    return svgRoot;
  }

  // Otherwise, search for the draggable child
  const draggable = svgRoot.querySelector(".blocklyDraggable");
  return draggable || svgRoot; // Fallback to root if no draggable found
}

/**
 * Get the path element for a block.
 * This is used for drag operations and visual manipulation.
 *
 * @param {Blockly.Block} block - The Blockly block
 * @returns {SVGPathElement|null} The path SVG element, or null if not found
 */
export function getBlockPathElement(block) {
  if (!block) return null;

  // New Blockly: use pathObject.svgPath
  if (block.pathObject?.svgPath) {
    return block.pathObject.svgPath;
  }

  // Old Blockly: fallback to svgPath_ property
  return block.svgPath_ || null;
}

/**
 * Get the path element from within a block's SVG structure.
 * This searches for the .blocklyPath element which contains the block's visual shape.
 *
 * @param {SVGGElement} blockElement - The block's SVG element
 * @returns {SVGPathElement|null} The path element, or null if not found
 */
export function getBlockPathFromElement(blockElement) {
  if (!blockElement) return null;
  return blockElement.querySelector(".blocklyPath");
}

/**
 * Find the block canvas element (the container for all blocks).
 *
 * @param {Element} element - Any element within the block canvas
 * @returns {SVGGElement|null} The block canvas element, or null if not found
 */
export function getBlockCanvas(element) {
  if (!element) return null;
  return element.closest(".blocklyBlockCanvas");
}

/**
 * Check if a block has an output connection (is a reporter/value block).
 * These blocks can be used as inputs to other blocks.
 *
 * @param {Blockly.Block} block - The Blockly block
 * @returns {boolean} True if the block has an output connection
 */
export function isReporterBlock(block) {
  return !!(block && block.outputConnection);
}

/**
 * Check if a block is a stack block (can connect vertically).
 * These blocks have previous/next connections for stacking.
 *
 * @param {Blockly.Block} block - The Blockly block
 * @returns {boolean} True if the block is a stack block
 */
export function isStackBlock(block) {
  return !!(block && (block.previousConnection || block.nextConnection));
}
