/**
 * Layered left-to-right layout for a focused dependency subgraph.
 *
 * Input:  nodes [{ key, depth }]   depth: 0 root, >0 dependencies (right), <0 dependents (left)
 *         edges [{ from, to }]
 * Output: { positions: Map<key, {x, y}>, width, height, columns }
 *
 * Column = depth. Rows inside a column are ordered by the barycenter of the
 * neighbours in the adjacent column (two sweeps) to reduce crossings, then
 * each column is centred vertically. Pure: no DOM, tested in isolation.
 */
export function layoutGraph(nodes, edges, { nodeWidth = 208, nodeHeight = 66, columnGap = 72, rowGap = 14 } = {}) {
  const columns = new Map();
  for (const n of nodes) {
    if (!columns.has(n.depth)) columns.set(n.depth, []);
    columns.get(n.depth).push(n.key);
  }
  const depths = [...columns.keys()].sort((a, b) => a - b);
  const neighbours = new Map();
  const touch = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const e of edges) {
    touch(e.from, e.to);
    touch(e.to, e.from);
  }

  // Initial order: stable by key so layout is deterministic.
  for (const d of depths) columns.get(d).sort();

  const order = new Map();
  const refreshOrder = () => {
    for (const d of depths) columns.get(d).forEach((k, i) => order.set(k, i));
  };
  refreshOrder();

  const sweep = (from, to) => {
    const seq = from < to ? depths : [...depths].reverse();
    for (let i = 1; i < seq.length; i += 1) {
      const prev = new Set(columns.get(seq[i - 1]));
      const col = columns.get(seq[i]);
      const bary = new Map();
      for (const k of col) {
        const nb = [...(neighbours.get(k) || [])].filter((x) => prev.has(x));
        bary.set(k, nb.length ? nb.reduce((s, x) => s + order.get(x), 0) / nb.length : order.get(k));
      }
      col.sort((a, b) => bary.get(a) - bary.get(b) || a.localeCompare(b));
      refreshOrder();
    }
  };
  sweep(0, 1);
  sweep(1, 0);
  sweep(0, 1);

  const colHeights = new Map();
  let maxHeight = 0;
  for (const d of depths) {
    const hgt = columns.get(d).length * nodeHeight + (columns.get(d).length - 1) * rowGap;
    colHeights.set(d, hgt);
    maxHeight = Math.max(maxHeight, hgt);
  }
  const minDepth = depths[0];
  const positions = new Map();
  for (const d of depths) {
    const x = (d - minDepth) * (nodeWidth + columnGap);
    const offset = (maxHeight - colHeights.get(d)) / 2;
    columns.get(d).forEach((k, i) => positions.set(k, { x, y: offset + i * (nodeHeight + rowGap) }));
  }
  return { positions, width: depths.length * nodeWidth + (depths.length - 1) * columnGap, height: maxHeight, columns, nodeWidth, nodeHeight };
}

/** Cubic path from the right edge of `a` to the left edge of `b` (or reverse when b is left of a). */
export function edgePath(a, b, nodeWidth, nodeHeight) {
  const ay = a.y + nodeHeight / 2;
  const by = b.y + nodeHeight / 2;
  let x1;
  let x2;
  if (b.x >= a.x) {
    x1 = a.x + nodeWidth;
    x2 = b.x;
  } else {
    x1 = a.x;
    x2 = b.x + nodeWidth;
  }
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  const c1 = x1 + (b.x >= a.x ? dx : -dx);
  const c2 = x2 - (b.x >= a.x ? dx : -dx);
  return `M ${x1} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${x2} ${by}`;
}
