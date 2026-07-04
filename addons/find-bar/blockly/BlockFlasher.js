import { collectTransforms, createTransformedGroup } from "../../../libraries/common/cs/svg-utils.js";

/**
 * Helper class to flash a Blockly scratch block in the users workspace
 */
export default class BlockFlasher {
  /**
   * Get the SVG path element for a block
   */
  static getSvgPath(block) {
    if (!block) return null;
    if (block.pathObject) return block.pathObject.svgPath; // new Blockly
    if (block.svgPath_) return block.svgPath_; // old Blockly

    // Fallback for shadow blocks (like text blocks)
    if (block.getSvgRoot) {
      const svgRoot = block.getSvgRoot();
      if (svgRoot) {
        return svgRoot.querySelector(".blocklyPath.blocklyBlockBackground");
      }
    }

    return null;
  }

  /**
   * FLash a block 3 times
   * @param block the block to flash
   */
  static flash(block) {
    if (myFlash.timerID > 0) {
      clearTimeout(myFlash.timerID);
      const path = this.getSvgPath(myFlash.block);
      if (path) path.style.fill = "";
    }

    let count = 4;
    let flashOn = true;
    myFlash.block = block;

    const _flash = () => {
      const path = this.getSvgPath(myFlash.block);
      if (path) {
        path.style.fill = flashOn ? "#ffff80" : "";
      }
      flashOn = !flashOn;
      count--;
      if (count > 0) {
        myFlash.timerID = setTimeout(_flash, 200);
      } else {
        myFlash.timerID = 0;
        myFlash.block = null;
      }
    };

    _flash();
  }

  /**
   * Create a selection effect with a growing/fading outline
   * @param block the block to show selection effect on
   */
  static selectionEffect(block) {
    // Clean up any existing selection effect
    this.clearSelectionEffect();

    const svgPath = this.getSvgPath(block);
    if (!svgPath?.ownerSVGElement) return;

    const workspaceSvg = svgPath.ownerSVGElement;
    const blockCanvas = svgPath.closest(".blocklyBlockCanvas");
    if (!blockCanvas) return;

    const maskId = `sa-find-mask-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Setup mask
    const { maskDef, maskShape } = this.createMask(workspaceSvg, maskId, svgPath);

    // Create outline with transforms to match block position
    const outline = this.createOutline(svgPath, maskId, blockCanvas);
    blockCanvas.appendChild(outline);

    // Store references for cleanup
    mySelection.outlineGroup = outline;
    mySelection.maskDef = maskDef;
    mySelection.animationId = null;

    // Animate
    this.animateOutline(outline, maskShape, maskDef);
  }

  /**
   * Clear any existing selection effect
   */
  static clearSelectionEffect() {
    if (mySelection.animationId) {
      cancelAnimationFrame(mySelection.animationId);
      mySelection.animationId = null;
    }
    if (mySelection.outlineGroup) {
      mySelection.outlineGroup.remove();
      mySelection.outlineGroup = null;
    }
    if (mySelection.maskDef) {
      mySelection.maskDef.remove();
      mySelection.maskDef = null;
    }
  }

  /**
   * Create the SVG mask definition
   */
  static createMask(workspaceSvg, maskId, svgPath) {
    let defs = workspaceSvg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      workspaceSvg.insertBefore(defs, workspaceSvg.firstChild);
    }

    const maskDef = document.createElementNS("http://www.w3.org/2000/svg", "mask");
    maskDef.setAttribute("id", maskId);
    maskDef.setAttribute("maskUnits", "userSpaceOnUse");

    // White background (everything visible)
    const maskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    Object.assign(maskRect.style, { x: "-10000", y: "-10000", width: "20000", height: "20000", fill: "white" });

    // Black shape masks out inner half - use fill only to cover the entire block
    const maskShape = svgPath.cloneNode(true);
    Object.assign(maskShape.style, { fill: "black", stroke: "none" });

    maskDef.appendChild(maskRect);
    maskDef.appendChild(maskShape);
    defs.appendChild(maskDef);

    return { maskDef, maskShape };
  }

  /**
   * Create the outline element
   */
  static createOutline(svgPath, maskId, blockCanvas) {
    const outline = svgPath.cloneNode(true);
    Object.assign(outline.style, { fill: "none", stroke: "#000000", strokeWidth: "6", pointerEvents: "none" });
    outline.setAttribute("mask", `url(#${maskId})`);

    // Collect transforms and create group
    const transforms = collectTransforms(svgPath, blockCanvas);
    const outlineGroup = createTransformedGroup(transforms, "sa-find-selection-outline-group");
    outlineGroup.appendChild(outline);

    return outlineGroup;
  }

  /**
   * Animate the outline expansion and fade
   */
  static animateOutline(outlineGroup, maskShape, maskDef) {
    const startTime = performance.now();
    const duration = 1000;
    const outline = outlineGroup.querySelector("path");

    const animate = () => {
      const progress = Math.min((performance.now() - startTime) / duration, 1);

      // Grow then shrink: 6px -> 28px -> 6px
      // Expand 15%, shrink 85%
      let outlineWidth;
      if (progress < 0.15) {
        // Expand phase (0% to 15%)
        const expandProgress = progress / 0.15;
        // Use ease-out for smooth expansion
        const eased = 1 - Math.pow(1 - expandProgress, 3);
        outlineWidth = 6 + eased * 22;
      } else {
        // Shrink phase (15% to 100%)
        const shrinkProgress = (progress - 0.15) / 0.85;
        // Use ease-in for smooth shrinking
        const eased = Math.pow(shrinkProgress, 3);
        outlineWidth = 28 - eased * 22;
      }
      outline.style.strokeWidth = outlineWidth;

      if (progress < 1) {
        mySelection.animationId = requestAnimationFrame(animate);
      } else {
        // Cleanup
        outlineGroup.remove();
        maskDef.remove();
        mySelection.outlineGroup = null;
        mySelection.maskDef = null;
        mySelection.animationId = null;
      }
    };

    mySelection.animationId = requestAnimationFrame(animate);
  }
}

const myFlash = { block: null, timerID: null };
const mySelection = { outlineGroup: null, maskDef: null, animationId: null };
