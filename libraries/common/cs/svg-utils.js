/**
 * Shared SVG utilities for working with Blockly blocks
 */

/**
 * Collect transform attributes from an element up to its canvas parent
 * @param {SVGElement} svgElement - The starting SVG element
 * @param {SVGElement} blockCanvas - The target canvas element to stop at
 * @returns {string[]} Array of transform strings in proper order
 */
export function collectTransforms(svgElement, blockCanvas) {
  const transforms = [];
  let currentGroup = svgElement.parentElement;
  
  while (currentGroup && currentGroup !== blockCanvas) {
    const transform = currentGroup.getAttribute("transform");
    if (transform) {
      transforms.unshift(transform);
    }
    currentGroup = currentGroup.parentElement;
  }
  
  return transforms;
}

/**
 * Create an SVG group with transforms applied
 * @param {string[]} transforms - Array of transform strings
 * @param {string} className - CSS class name for the group
 * @returns {SVGGElement} The created group element
 */
export function createTransformedGroup(transforms, className) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", className);
  
  if (transforms.length > 0) {
    group.setAttribute("transform", transforms.join(" "));
  }
  
  return group;
}
