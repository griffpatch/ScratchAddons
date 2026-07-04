/**
 * Pure utility functions for the rig tool.
 * All functions that operate on the Paper.js data model take `paper` as their
 * first argument so they are not bound to a global reference.
 */

/**
 * Find the pivot marker item inside a group, or null if none exists.
 * A pivot marker is any item with data.rigPivot === true.
 * @param {paper.Group} group
 * @returns {paper.Item|null}
 */
export function findPivotItem(group) {
  if (!group.children) return null;
  for (const child of group.children) {
    if (child.data?.rigPivot) return child;
  }
  return null;
}

/**
 * Return the world-space position of a group's pivot marker, or null.
 * @param {paper.Group} group
 * @returns {paper.Point|null}
 */
export function getPivotPos(group) {
  const pivot = findPivotItem(group);
  return pivot ? pivot.position : null;
}

/**
 * Insert a new pivot marker into a group at the given world-space point.
 * The marker is invisible and excluded from paint-editor selection.
 * @param {object} paper - Paper.js module
 * @param {paper.Group} group
 * @param {paper.Point} worldPt
 * @returns {paper.Item}
 */
export function createPivotAt(paper, group, worldPt) {
  const circle = new paper.Path.Circle(worldPt, 1);
  circle.fillColor = null;
  circle.strokeColor = null;
  circle.opacity = 0;
  // isHelperItem hides this from paint-editor selection (scratch-paint convention).
  // rigPivot identifies it as a rig pivot marker for this addon.
  // data-paper-data is serialised to SVG on export and restored on import.
  circle.data = { isHelperItem: true, rigPivot: true };
  group.addChild(circle);
  return circle;
}

/**
 * Remove the pivot marker from a group (no-op if group has none).
 * @param {paper.Group} group
 */
export function deletePivot(group) {
  findPivotItem(group)?.remove();
}

/**
 * Return the painting layer, or null.
 * The painting layer has data.isPaintingLayer === true and is NOT the guide layer.
 * @param {object} paper - Paper.js module
 * @returns {paper.Layer|null}
 */
export function getPaintLayer(paper) {
  return paper.project.layers.find((l) => l.data?.isPaintingLayer && !l.data?.isGuideLayer) ?? null;
}

/**
 * Recursively find all groups in `root` that contain a pivot marker.
 * @param {object} paper - Paper.js module
 * @param {paper.Item} root - typically the painting layer
 * @returns {Array<{group: paper.Group, pivot: paper.Item}>}
 */
export function findAllRigGroups(paper, root) {
  const results = [];
  const scan = (item) => {
    if (!(item instanceof paper.Group) || item.data?.isHelperItem) return;
    const pivot = findPivotItem(item);
    if (pivot) results.push({ group: item, pivot });
    for (const child of item.children) scan(child);
  };
  for (const child of root.children ?? []) scan(child);
  return results;
}

/**
 * Return all direct children of the painting layer hit at a point, in
 * front-to-back (topmost first) z-order.  Helper items are excluded.
 * Used by edit mode to detect bare shapes beneath the clicked item.
 * @param {object} paper - Paper.js module
 * @param {paper.Point} point
 * @returns {paper.Item[]}
 */
export function findAllPaintRootItemsAtPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return [];
  const hits = paper.project.hitTestAll(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });
  // Walk each hit up to its direct child of the painting layer, deduplicate.
  const seen = new Set();
  const results = [];
  for (const hit of hits) {
    let item = hit.item;
    while (item && item.parent !== paintLayer) item = item.parent;
    if (item && !seen.has(item)) {
      seen.add(item);
      results.push(item);
    }
  }
  return results; // topmost (highest z) first
}

/**
 * Find the direct child of the painting layer that was hit at a point,
 * regardless of whether it is a Group or a bare Path / Shape.
 * Returns null if the hit is outside the painting layer or on a helper item.
 * Used by edit mode to detect bare shapes that need to be auto-grouped.
 * @param {object} paper - Paper.js module
 * @param {paper.Point} point
 * @returns {paper.Item|null}
 */
export function findPaintRootItemAtPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return null;
  const hitResult = paper.project.hitTest(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });
  if (!hitResult) return null;
  // Walk up to the direct child of the painting layer.
  let item = hitResult.item;
  while (item && item.parent !== paintLayer) {
    item = item.parent;
  }
  return item ?? null;
}

/**
 * Build an IK chain for CCD solving: an array of groups from the given group
 * outward toward the painting layer root, including only groups that have a
 * pivot marker. The innermost group (startGroup) comes first.
 * @param {object} paper - Paper.js module
 * @param {paper.Group} startGroup
 * @returns {Array<paper.Group>}
 */
export function getAncestorRigChain(paper, startGroup) {
  const chain = [];
  let current = startGroup;
  while (current && !(current instanceof paper.Layer)) {
    if (current instanceof paper.Group && !current.data?.isHelperItem && findPivotItem(current)) {
      chain.push(current);
    }
    current = current.parent;
  }
  return chain; // innermost first
}

/**
 * Find the innermost (deepest) group under a paper-space point, or null.
 * Ignores helper items and items outside the painting layer.
 * @param {object} paper - Paper.js module
 * @param {paper.Point} point - paper-space coordinates
 * @returns {paper.Group|null}
 */
export function findGroupAtPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return null;
  const hitResult = paper.project.hitTest(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });
  if (!hitResult) return null;
  let item = hitResult.item;
  while (item && !(item instanceof paper.Layer)) {
    if (item instanceof paper.Group && !item.data?.isHelperItem) return item;
    item = item.parent;
  }
  return null;
}

/**
 * Find the innermost ancestor group under `point` that has a pivot marker.
 * Used by move mode: clicking a nested limb rotates that specific limb, not
 * the whole skeleton.
 * @param {object} paper
 * @param {paper.Point} point
 * @returns {paper.Group|null}
 */
export function findInnermostRigGroupAtPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return null;
  const hitResult = paper.project.hitTest(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });
  if (!hitResult) return null;
  // Walk upward from the hit item; return the first (innermost) group with a pivot.
  let item = hitResult.item;
  while (item && !(item instanceof paper.Layer)) {
    if (item instanceof paper.Group && !item.data?.isHelperItem && findPivotItem(item)) {
      return item;
    }
    item = item.parent;
  }
  return null;
}

/**
 * Find the outermost ancestor group (closest to the painting layer) that contains
 * the point and has a pivot marker.  Used by IK mode's chain root detection.
 * @param {object} paper
 * @param {paper.Point} point
 * @returns {paper.Group|null}
 */
export function findOutermostRigGroupAtPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return null;
  const hitResult = paper.project.hitTest(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });
  if (!hitResult) return null;
  // Walk from hit item up toward the layer, collecting all ancestor groups with pivots.
  // The last one found is the outermost.
  let item = hitResult.item;
  let outermostPivoted = null;
  while (item && !(item instanceof paper.Layer)) {
    if (item instanceof paper.Group && !item.data?.isHelperItem && findPivotItem(item)) {
      outermostPivoted = item;
    }
    item = item.parent;
  }
  return outermostPivoted;
}

/**
 * Find the innermost rigged group (with a pivot) at a point by testing ALL
 * overlapping items — not just the topmost one.  This lets edit mode find a
 * rigged group that is visually "beneath" an un-rigged item the user is about
 * to pin, so the new bone is correctly nested inside the deepest matching limb.
 *
 * Unlike findInnermostRigGroupAtPoint (which uses hitTest and only sees the
 * topmost item), this function uses hitTestAll and selects the candidate with
 * the greatest nesting depth.
 *
 * @param {object} paper - Paper.js module
 * @param {paper.Point} point
 * @returns {paper.Group|null}
 */
export function findInnermostRigGroupUnderPoint(paper, point) {
  const paintLayer = getPaintLayer(paper);
  if (!paintLayer) return null;

  const hits = paper.project.hitTestAll(point, {
    fill: true,
    stroke: true,
    tolerance: 4 / paper.view.zoom,
    match: (r) => !r.item.data?.isHelperItem && (paintLayer.isAncestor(r.item) || r.item.layer === paintLayer),
  });

  let best = null;
  let bestDepth = -1;

  for (const hit of hits) {
    // Walk upward from this hit item to find its nearest rigged ancestor group.
    let item = hit.item;
    while (item && !(item instanceof paper.Layer)) {
      if (item instanceof paper.Group && !item.data?.isHelperItem && findPivotItem(item)) {
        // Count nesting depth: deeper = more specific limb = preferred.
        let depth = 0;
        let p = item;
        while (p && !(p instanceof paper.Layer)) {
          depth++;
          p = p.parent;
        }
        if (depth > bestDepth) {
          bestDepth = depth;
          best = item;
        }
        break; // only take the innermost rigged ancestor of this hit path
      }
      item = item.parent;
    }
  }

  return best;
}
