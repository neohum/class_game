// scripts/visual-inspector/grid-detector.ts
// Algorithms for 1D proximity clustering and alignment guide line detection.

import type { BoundingBox, AlignmentGuide, GuideEdge, GuideOrientation } from "./types.ts";

interface PointEntry {
  val: number;
  id: string;
  edge: GuideEdge;
}

/**
 * 1D Proximity clustering with tolerance epsilon.
 */
export function cluster1D(
  points: PointEntry[],
  tolerance = 2
): Array<{ position: number; edge: GuideEdge; items: PointEntry[] }> {
  if (points.length === 0) return [];

  // Sort ascending by value
  const sorted = [...points].sort((a, b) => a.val - b.val);
  const clusters: Array<{ items: PointEntry[]; edge: GuideEdge }> = [];

  for (const pt of sorted) {
    if (clusters.length === 0) {
      clusters.push({ items: [pt], edge: pt.edge });
      continue;
    }

    const lastCluster = clusters[clusters.length - 1]!;
    // Calculate current cluster mean
    const currentSum = lastCluster.items.reduce((acc, it) => acc + it.val, 0);
    const currentMean = currentSum / lastCluster.items.length;

    // Check proximity to mean and last point
    const lastItem = lastCluster.items[lastCluster.items.length - 1]!;
    if (Math.abs(pt.val - currentMean) <= tolerance || Math.abs(pt.val - lastItem.val) <= tolerance) {
      lastCluster.items.push(pt);
    } else {
      clusters.push({ items: [pt], edge: pt.edge });
    }
  }

  return clusters.map((c) => {
    const sum = c.items.reduce((acc, it) => acc + it.val, 0);
    const mean = Math.round((sum / c.items.length) * 100) / 100;
    return {
      position: mean,
      edge: c.edge,
      items: c.items,
    };
  });
}

/**
 * Detects horizontal and vertical alignment guides across an element set.
 */
export function detectAlignmentGuides(
  elements: BoundingBox[],
  options: { tolerance?: number; minClusterCount?: number } = {}
): AlignmentGuide[] {
  const tolerance = options.tolerance ?? 2;
  const minClusterCount = options.minClusterCount ?? 1;

  const guides: AlignmentGuide[] = [];

  // Group elements into coordinate candidate buckets
  const vLeft: PointEntry[] = [];
  const vCenter: PointEntry[] = [];
  const vRight: PointEntry[] = [];

  const hTop: PointEntry[] = [];
  const hCenter: PointEntry[] = [];
  const hBottom: PointEntry[] = [];

  for (const el of elements) {
    vLeft.push({ val: el.left, id: el.id, edge: "left" });
    vCenter.push({ val: el.centerX, id: el.id, edge: "center" });
    vRight.push({ val: el.right, id: el.id, edge: "right" });

    hTop.push({ val: el.top, id: el.id, edge: "top" });
    hCenter.push({ val: el.centerY, id: el.id, edge: "center" });
    hBottom.push({ val: el.bottom, id: el.id, edge: "bottom" });
  }

  const vBuckets: Array<{ items: PointEntry[]; edge: GuideEdge }> = [
    { items: vLeft, edge: "left" },
    { items: vCenter, edge: "center" },
    { items: vRight, edge: "right" },
  ];

  const hBuckets: Array<{ items: PointEntry[]; edge: GuideEdge }> = [
    { items: hTop, edge: "top" },
    { items: hCenter, edge: "center" },
    { items: hBottom, edge: "bottom" },
  ];

  // Process vertical guides
  for (const bucket of vBuckets) {
    const clusters = cluster1D(bucket.items, tolerance);
    for (const cl of clusters) {
      if (cl.items.length >= minClusterCount) {
        const uniqueIds = Array.from(new Set(cl.items.map((it) => it.id)));
        guides.push({
          id: `guide-v-${bucket.edge}-${Math.round(cl.position)}`,
          orientation: "vertical",
          edge: bucket.edge,
          position: cl.position,
          elementIds: uniqueIds,
          clusterCount: cl.items.length,
        });
      }
    }
  }

  // Process horizontal guides
  for (const bucket of hBuckets) {
    const clusters = cluster1D(bucket.items, tolerance);
    for (const cl of clusters) {
      if (cl.items.length >= minClusterCount) {
        const uniqueIds = Array.from(new Set(cl.items.map((it) => it.id)));
        guides.push({
          id: `guide-h-${bucket.edge}-${Math.round(cl.position)}`,
          orientation: "horizontal",
          edge: bucket.edge,
          position: cl.position,
          elementIds: uniqueIds,
          clusterCount: cl.items.length,
        });
      }
    }
  }

  return guides;
}

/**
 * Finds the nearest alignment guide for a given edge and coordinate.
 */
export function findNearestGuide(
  position: number,
  guides: AlignmentGuide[],
  edge?: GuideEdge,
  orientation?: GuideOrientation
): { guide: AlignmentGuide; distance: number } | null {
  let nearest: AlignmentGuide | null = null;
  let minDistance = Infinity;

  for (const g of guides) {
    if (edge && g.edge !== edge) continue;
    if (orientation && g.orientation !== orientation) continue;

    const dist = Math.abs(g.position - position);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = g;
    }
  }

  if (!nearest) return null;
  return { guide: nearest, distance: Math.round(minDistance * 100) / 100 };
}
