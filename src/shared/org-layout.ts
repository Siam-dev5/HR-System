// Organization chart layout ("inverted bell"): pure geometry over the reporting forest, no DOM (unit-tested).
// - Position Level and reporting line are separate. The level picks the band (row) of a card; manager_id (through the
//   forest) alone decides the parent. A card never sits above its manager: when the level would put it there (e.g.
//   L5 reporting to an L5), it drops to the first row below the manager. Nothing is re-parented.
// - Staff / Admin (L5 without reports) under one manager form a grid of at most 3 cards per row, 3 + 3 + … with the
//   last row centred; a big team grows downwards instead of sideways. Only the people of one manager share a grid.
// - A manager's teams (subtrees and the staff grid) sit side by side; when that row would be too wide for the screen,
//   they are stacked in tiers of two around a vertical trunk under the manager (balanced multi-row layout). Within a
//   tier the levels still line up (L3 with L3, L4 with L4, …). `aspect` (stage width / height) lets the layout pick
//   the arrangement that fits the screen best; without it everything stays side by side.
// - Connectors run in the gaps only (bus under the manager, trunk between the two tier columns, spine beside a
//   multi-row grid, bus above each grid row), so no line crosses a card. Cards keep their size.
// - Groups (one per company in the all-companies view) have their own header and wrap into rows when too wide;
//   people without a manager and without reports go to a separate "no reporting line" block under their company.
import type { OrgForest } from './org-tree';
import type { OrgLevel } from './org-levels';

export const CARD_W = 210;
export const CARD_H = 66;
/** between subtrees / tree cards */
export const GAP_X = 18;
/** between rows (bands) of the tree */
export const GAP_Y = 46;
export const GRID_COLS = 3;
export const GRID_GAP_X = 18;
export const GRID_GAP_Y = 28;
/** margin on both sides of a multi-row grid; the connector spine runs in the left one */
export const SPINE = 14;
/** gap between the two tier columns of a stacked manager; the trunk runs in its middle */
export const TRUNK_GAP = 56;
/** extra space between two tiers (the branch line to the next tier runs in it) */
export const TIER_GAP = 30;
export const GROUP_GAP = 80;
export const HEADER_H = 44;
/** space above the "no reporting line" block (its title sits inside the frame) */
export const ORPHAN_GAP = 40;
export const ORPHAN_PAD = 16;
export const ORPHAN_TITLE = 26;
export const BAND_LABEL_W = 132;
const MARGIN = 10;
const ROW_H = CARD_H + GAP_Y;

export interface LayoutOptions {
  forest: OrgForest;
  levelOf: (id: number) => OrgLevel;
  /** group (company) of a person */
  groupOf: (id: number) => number;
  /** groups in display order; label null = no header (single company) */
  groups: ReadonlyArray<{ key: number; label: string | null }>;
  /** the person has a manager_id at all (in or outside the chart) */
  hasManager: (id: number) => boolean;
  collapsed: ReadonlySet<number>;
  /** stage width / height: choose the stacking that fits it best (omit = no stacking) */
  aspect?: number;
  /** fixed stacking width (tests); overrides `aspect` */
  maxRowWidth?: number;
}

export interface LayoutNode {
  x: number;
  y: number;
  /** band index (level − 1, or lower when the reporting line forces it) */
  row: number;
  /** placed in a Staff / Admin grid (gridRow = row inside the grid) */
  grid: { parent: number; gridRow: number; col: number } | null;
  orphan: boolean;
}

export interface LayoutEdge {
  from: number;
  to: number;
  /** from a manager shown only as context (outside the department filter) */
  context: boolean;
  /** orthogonal polyline from the manager's bottom centre to the report's top centre */
  points: Array<[number, number]>;
}

export interface LayoutGroup {
  key: number;
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOrphans {
  key: number;
  ids: number[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrgLayout {
  nodes: Map<number, LayoutNode>;
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  orphans: LayoutOrphans[];
  /** rows that hold cards at their own level only, for the level labels (a level can repeat in stacked tiers) */
  bands: Array<{ level: OrgLevel; y: number }>;
  bounds: { x: number; y: number; w: number; h: number };
  /** managers whose teams were stacked in tiers */
  stacked: number[];
  /** the stacking width that was used (Infinity = none) */
  maxRowWidth: number;
}

/** Width of a Staff / Admin grid of n cards (with the spine margins when it has more than one row). */
export function gridWidth(n: number): number {
  const cols = Math.min(GRID_COLS, n);
  const rows = Math.ceil(n / GRID_COLS);
  return cols * CARD_W + (cols - 1) * GRID_GAP_X + (rows > 1 ? 2 * SPINE : 0);
}

type Pt = [number, number];
interface Sink { nodes: Map<number, LayoutNode>; edges: LayoutEdge[] }
/** a laid-out piece with its own origin (top-left); `put` writes it at an absolute offset */
interface Block { w: number; h: number; cx: number; put: (sink: Sink, dx: number, dy: number) => void }
/** a child of a manager: a subtree or the staff grid; `emit` also draws the lines from the feed point */
interface Item { w: number; h: number; row: number; emit: (sink: Sink, dx: number, dy: number, prefix: Pt[]) => void }

/** removes repeated and collinear points of an orthogonal polyline */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function layoutOnce(o: LayoutOptions, maxRowWidth: number): OrgLayout {
  const { forest, levelOf, collapsed } = o;
  const node = (id: number) => forest.nodes.get(id);
  const kidsShown = (id: number) => (collapsed.has(id) ? [] : node(id)?.children ?? []);
  const stacked: number[] = [];

  // ---- rows: own level, but always below the manager (iterative) ----
  const row = new Map<number, number>();
  for (const r of forest.roots) {
    row.set(r, levelOf(r) - 1);
    const stack = [r];
    while (stack.length) {
      const id = stack.pop() as number;
      for (const k of node(id)?.children ?? []) {
        row.set(k, Math.max(levelOf(k) - 1, (row.get(id) as number) + 1));
        stack.push(k);
      }
    }
  }
  const rowOf = (id: number) => row.get(id) as number;
  const gridable = (id: number) => levelOf(id) === 5 && (node(id)?.children.length ?? 0) === 0;

  const gridItem = (parent: number, ids: number[], context: boolean): Item => {
    const n = ids.length;
    const cols = Math.min(GRID_COLS, n);
    const rows = Math.ceil(n / GRID_COLS);
    const margin = rows > 1 ? SPINE : 0;
    return {
      w: gridWidth(n),
      h: rows * CARD_H + (rows - 1) * GRID_GAP_Y,
      row: rowOf(ids[0] as number),
      emit: (sink, dx, dy, prefix) => {
        const feed = prefix[prefix.length - 1] as Pt;
        const spineX = dx + margin / 2;
        ids.forEach((k, i) => {
          const gr = Math.floor(i / GRID_COLS);
          const col = i % GRID_COLS;
          const inRow = Math.min(GRID_COLS, n - gr * GRID_COLS);
          const x = dx + margin + ((cols - inRow) * (CARD_W + GRID_GAP_X)) / 2 + col * (CARD_W + GRID_GAP_X);
          const ty = dy + gr * (CARD_H + GRID_GAP_Y);
          const kcx = x + CARD_W / 2;
          sink.nodes.set(k, { x, y: ty, row: rowOf(k), grid: { parent, gridRow: gr, col }, orphan: false });
          const busY = ty - GRID_GAP_Y / 2;
          sink.edges.push({
            from: parent, to: k, context,
            points: simplify(gr === 0 ? [...prefix, [kcx, feed[1]], [kcx, ty]] : [...prefix, [spineX, feed[1]], [spineX, busY], [kcx, busY], [kcx, ty]]),
          });
        });
      },
    };
  };

  /** the subtree of `id` as a block (recursion depth = reporting depth) */
  const block = (id: number): Block => {
    const context = forest.context.has(id);
    const kids = kidsShown(id);
    const branches: Item[] = kids.filter((k) => !gridable(k)).map((k) => {
      const b = block(k);
      return {
        w: b.w, h: b.h, row: rowOf(k),
        emit: (sink, dx, dy, prefix) => {
          b.put(sink, dx, dy);
          const feed = prefix[prefix.length - 1] as Pt;
          sink.edges.push({ from: id, to: k, context, points: simplify([...prefix, [dx + b.cx, feed[1]], [dx + b.cx, dy]]) });
        },
      };
    });
    const staff = kids.filter(gridable);
    const items = [...branches];
    // the staff block sits in the middle of the manager's other branches (balanced bell)
    if (staff.length) items.splice(Math.floor(branches.length / 2), 0, gridItem(id, staff, context));
    const me = rowOf(id);
    const card = (sink: Sink, x: number, y: number) => sink.nodes.set(id, { x, y, row: me, grid: null, orphan: false });
    const itemsW = items.reduce((a, it) => a + it.w, 0) + GAP_X * Math.max(0, items.length - 1);

    if (items.length < 2 || itemsW <= maxRowWidth) {
      // side by side under one bus
      const w = Math.max(CARD_W, itemsW);
      const cx = w / 2;
      const h = Math.max(CARD_H, ...items.map((it) => (it.row - me) * ROW_H + it.h));
      return {
        w, h, cx,
        put: (sink, dx, dy) => {
          card(sink, dx + cx - CARD_W / 2, dy);
          const prefix: Pt[] = [[dx + cx, dy + CARD_H], [dx + cx, dy + CARD_H + GAP_Y / 2]];
          let kx = dx + (w - itemsW) / 2;
          for (const it of items) {
            it.emit(sink, kx, dy + (it.row - me) * ROW_H, prefix);
            kx += it.w + GAP_X;
          }
        },
      };
    }

    // stacked: tiers of two (left | trunk | right); same levels line up inside a tier
    stacked.push(id);
    // same levels pair up (manager with manager, staff block with staff); input order is kept within a level
    const order = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.row - b.it.row || a.i - b.i).map((x) => x.it);
    // two columns around a central trunk; when even that is too wide, one column on a trunk down the left side
    const pairs: Item[][] = [];
    for (let i = 0; i < order.length; i += 2) pairs.push(order.slice(i, i + 2));
    const twoW = Math.max(...pairs.map((t) => (t[0] as Item).w)) + TRUNK_GAP + Math.max(0, ...pairs.map((t) => t[1]?.w ?? 0));
    const oneCol = twoW > maxRowWidth;
    const tiers: Item[][] = oneCol ? order.map((it) => [it]) : pairs;
    const leftW = oneCol ? 0 : Math.max(...tiers.map((t) => (t[0] as Item).w));
    const rightW = oneCol ? Math.max(...order.map((it) => it.w)) : Math.max(0, ...tiers.map((t) => t[1]?.w ?? 0));
    const w = Math.max(CARD_W, leftW + TRUNK_GAP + rightW);
    const trunkX = leftW + TRUNK_GAP / 2;
    const placed: Array<{ it: Item; x: number; y: number }> = [];
    let tierTop = -1;
    for (const t of tiers) {
      const base = Math.min(...t.map((it) => it.row));
      // the first tier keeps the level spacing below the manager; later tiers start under the previous one
      const y0 = tierTop < 0 ? (base - me) * ROW_H : tierTop;
      t.forEach((it, side) => placed.push({ it, x: oneCol ? TRUNK_GAP : side === 0 ? leftW - it.w : leftW + TRUNK_GAP, y: y0 + (it.row - base) * ROW_H }));
      tierTop = Math.max(...t.map((it, side) => (placed[placed.length - t.length + side] as { y: number }).y + it.h)) + GAP_Y + TIER_GAP;
    }
    const h = Math.max(CARD_H, ...placed.map((p) => p.y + p.it.h));
    return {
      // one column: the card sits at the left edge and the trunk leaves from under it
      w, h, cx: oneCol ? CARD_W / 2 : trunkX,
      put: (sink, dx, dy) => {
        card(sink, dx + (oneCol ? 0 : trunkX - CARD_W / 2), dy);
        for (const p of placed) {
          const branchY = dy + p.y - GAP_Y / 2;
          p.it.emit(sink, dx + p.x, dy + p.y, [[dx + trunkX, dy + CARD_H], [dx + trunkX, branchY]]);
        }
      },
    };
  };

  const sink: Sink = { nodes: new Map(), edges: [] };
  const groups: LayoutGroup[] = [];
  const orphanBlocks: LayoutOrphans[] = [];
  const anyHeader = o.groups.some((g) => g.label !== null);
  let cursorX = 0;
  let rowTop = MARGIN;
  let rowBottom = MARGIN;
  for (const g of o.groups) {
    const roots = forest.roots.filter((r) => o.groupOf(r) === g.key);
    if (!roots.length) continue;
    const isOrphan = (r: number) => {
      const n = node(r);
      return !!n && n.children.length === 0 && !n.cycle && !n.context && !o.hasManager(r);
    };
    const orphans = roots.filter(isOrphan);
    const trees = roots.filter((r) => !isOrphan(r)).map((r) => ({ r, b: block(r) }));
    const treeW = trees.reduce((a, t) => a + t.b.w, 0) + GAP_X * Math.max(0, trees.length - 1);
    const oCols = Math.min(GRID_COLS, orphans.length);
    const oRows = Math.ceil(orphans.length / GRID_COLS);
    const oW = orphans.length ? oCols * CARD_W + Math.max(0, oCols - 1) * GRID_GAP_X + 2 * ORPHAN_PAD : 0;
    const innerW = Math.max(treeW, oW);
    // groups wrap into a new row when the current one would get too wide
    if (cursorX > 0 && cursorX + innerW > maxRowWidth) {
      cursorX = 0;
      rowTop = rowBottom + GROUP_GAP;
    }
    const top = rowTop + (anyHeader ? HEADER_H : 0);
    // a root sits at its level band (the MD on top, an AMD-only company starts one band lower)
    const minRow = Math.min(0, ...trees.map((t) => row.get(t.r) as number));
    let x = cursorX + (innerW - treeW) / 2;
    let bottom = top;
    for (const t of trees) {
      const y = top + ((row.get(t.r) as number) - minRow) * ROW_H;
      t.b.put(sink, x, y);
      bottom = Math.max(bottom, y + t.b.h);
      x += t.b.w + GAP_X;
    }
    if (orphans.length) {
      const fx = cursorX + (innerW - oW) / 2;
      const fy = trees.length ? bottom + ORPHAN_GAP : top;
      orphans.forEach((id, i) => {
        const gr = Math.floor(i / GRID_COLS);
        const col = i % GRID_COLS;
        const inRow = Math.min(GRID_COLS, orphans.length - gr * GRID_COLS);
        sink.nodes.set(id, {
          x: fx + ORPHAN_PAD + ((oCols - inRow) * (CARD_W + GRID_GAP_X)) / 2 + col * (CARD_W + GRID_GAP_X),
          y: fy + ORPHAN_PAD + ORPHAN_TITLE + gr * (CARD_H + GRID_GAP_Y),
          row: levelOf(id) - 1, grid: null, orphan: true,
        });
      });
      const h = ORPHAN_PAD + ORPHAN_TITLE + oRows * CARD_H + (oRows - 1) * GRID_GAP_Y + ORPHAN_PAD;
      orphanBlocks.push({ key: g.key, ids: orphans, x: fx, y: fy, w: oW, h });
      bottom = fy + h;
    }
    groups.push({ key: g.key, label: g.label, x: cursorX - 16, y: rowTop, w: innerW + 32, h: bottom + 16 - rowTop });
    rowBottom = Math.max(rowBottom, bottom + 16);
    cursorX += innerW + GROUP_GAP;
  }

  // level labels: a row is labelled when every card on it (first grid row only) sits at its own level
  const atY = new Map<number, Set<OrgLevel>>();
  for (const [id, n] of sink.nodes) {
    if (n.orphan || (n.grid && n.grid.gridRow > 0)) continue;
    const set = atY.get(n.y) ?? new Set<OrgLevel>();
    set.add(n.row === levelOf(id) - 1 ? levelOf(id) : (0 as OrgLevel));
    atY.set(n.y, set);
  }
  const bands = [...atY.entries()].filter(([, s]) => s.size === 1 && !s.has(0 as OrgLevel)).sort((a, b) => a[0] - b[0]).map(([y, s]) => ({ level: [...s][0] as OrgLevel, y }));

  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of sink.nodes.values()) {
    xs.push(n.x, n.x + CARD_W);
    ys.push(n.y, n.y + CARD_H);
  }
  for (const g of groups) if (g.label !== null) {
    xs.push(g.x, g.x + g.w);
    ys.push(g.y, g.y + g.h);
  }
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : CARD_W;
  const maxY = ys.length ? Math.max(...ys) : CARD_H;
  const left = minX - (bands.length ? BAND_LABEL_W : MARGIN);
  return { nodes: sink.nodes, edges: sink.edges, groups, orphans: orphanBlocks, bands, bounds: { x: left, y: 0, w: maxX + MARGIN - left, h: maxY + MARGIN }, stacked, maxRowWidth };
}

/**
 * Lays the chart out. With `aspect` (stage width / height) it tries narrower stacking widths and keeps the one whose
 * whole-chart fit is largest on that stage; a tie keeps the wider (less stacked) arrangement.
 */
export function layoutOrg(o: LayoutOptions): OrgLayout {
  if (o.maxRowWidth !== undefined) return layoutOnce(o, o.maxRowWidth);
  const natural = layoutOnce(o, Infinity);
  if (!o.aspect || !(o.aspect > 0)) return natural;
  const aspect = o.aspect;
  const score = (l: OrgLayout) => Math.min(aspect / l.bounds.w, 1 / l.bounds.h);
  let best = natural;
  let bestScore = score(natural);
  const full = natural.bounds.w;
  for (let f = 0.9; f >= 0.1; f -= 0.05) {
    const l = layoutOnce(o, full * f);
    const s = score(l);
    if (s > bestScore * 1.01) {
      best = l;
      bestScore = s;
    }
  }
  return best;
}
