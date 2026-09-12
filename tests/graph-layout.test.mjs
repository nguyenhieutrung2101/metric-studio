import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, edgePath } from '../src/ui/graph/graph-layout.js';

test('places columns by depth left-to-right and centres them vertically', () => {
  const nodes = [{ key: 'root', depth: 0 }, { key: 'a', depth: 1 }, { key: 'b', depth: 1 }, { key: 'c', depth: 2 }, { key: 'up', depth: -1 }];
  const edges = [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }, { from: 'a', to: 'c' }, { from: 'up', to: 'root' }];
  const L = layoutGraph(nodes, edges, { nodeWidth: 100, nodeHeight: 50, columnGap: 20, rowGap: 10 });
  assert.equal(L.positions.get('up').x, 0);
  assert.equal(L.positions.get('root').x, 120);
  assert.equal(L.positions.get('a').x, 240);
  assert.equal(L.positions.get('c').x, 360);
  assert.equal(L.height, 110, 'tallest column has two nodes');
  assert.equal(L.positions.get('root').y, 30, 'single node column is centred');
  assert.equal(L.width, 4 * 100 + 3 * 20);
});

test('barycenter ordering reduces crossings', () => {
  const nodes = [{ key: 'r1', depth: 0 }, { key: 'r2', depth: 0 }, { key: 'x', depth: 1 }, { key: 'y', depth: 1 }];
  // r1 → y and r2 → x would cross with alphabetical order; layout should reorder one column.
  const edges = [{ from: 'r1', to: 'y' }, { from: 'r2', to: 'x' }];
  const L = layoutGraph(nodes, edges);
  const order = (k) => L.positions.get(k).y;
  assert.equal(order('r1') < order('r2'), order('y') < order('x'), 'neighbours keep the same relative order');
});

test('edge path starts at the right edge and ends at the left edge for forward edges', () => {
  const d = edgePath({ x: 0, y: 0 }, { x: 200, y: 100 }, 100, 50);
  assert.match(d, /^M 100 25 C /);
  assert.match(d, / 200 125$/);
  const back = edgePath({ x: 200, y: 0 }, { x: 0, y: 0 }, 100, 50);
  assert.match(back, /^M 200 25 C /);
});
