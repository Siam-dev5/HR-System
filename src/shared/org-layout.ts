// Organization chart layout (master template): pure geometry over the reporting forest, no DOM (unit-tested).
// - Tidy tree: a manager sits centred over its teams, the teams of a manager sit side by side and every subtree keeps
//   its own column, so the chart spreads left / centre / right like the master template instead of folding into a
//   narrow column. Lines run only in the gaps (bus under the manager, spine beside a staff block), never over a card.
// - Position Level and reporting line are separate. The level picks the band (row) of a card — the five bands L1–L5
//   are the same for every company, so the level labels line up with every card of that level. manager_id (through
//   the forest) alone decides the parent. A card never sits above its manager: when the level would put it there
//   (e.g. L5 reporting to an L5) it drops to the first row below the manager. Nothing is re-parented.
// - Staff / Admin (L5 without reports) of one manager form a block: 1–3 people stacked in one column (as in the
//   template), 4–6 in two columns, 7 or more in three; never more than 3 per row, the last row centred.
// - Per company: the largest tree is centred; other trees, people whose manager is outside the company (one titled
//   frame per such manager, no line across companies) and the "no reporting line" block are balanced left / right.
// - Companies (all-companies view) sit side by side, each in its own frame, on the same level bands.
// - Cross company references (optional): a reference card of a person responsible for a department / team of this
//   company (shared/cross-company) sits in a titled frame per target department at the left end of the company, on
//   the band of that person's level. A reference is not a node: it is never counted and never gets a reporting line.
import type { OrgForest } from './org-tree';
import type { OrgLevel } from './org-levels';

export const CARD_W = 210;
export const CARD_H = 66;
/** between the teams of one manager */
export const GAP_X = 24;
/** between rows (bands) of the tree */
export const GAP_Y = 46;
export const GRID_COLS = 3;
export const GRID_GAP_X = 18;
export const GRID_GAP_Y = 24;
/** margin on both sides of a multi-row staff block; the connector spine runs in the left one */
export const SPINE = 14;
/** between the units (trees, frames) of one company */
export const UNIT_GAP = 48;
export const GROUP_GAP = 96;
export const HEADER_H = 44;
/** free space above the first band inside a company (room for a frame title) */
export const TOP_PAD = 40;
export const FRAME_PAD = 14;
export const FRAME_TITLE = 24;
/** width of the level labels in exports (the live chart shows them in a fixed rail) */
export const BAND_LABEL_W = 132;
export const LEVELS: readonly OrgLevel[] = [1, 2, 3, 4, 5];
const MARGIN = 10;
const ROW_H = CARD_H + GAP_Y;

export interface LayoutOptions {
  forest: OrgForest;
  levelOf: (id: number) => OrgLevel;
  /** group (company) of a person */
  groupOf: (id: number) => number;
  /** groups in display order; label null = no header (single company) */
  groups: ReadonlyArray<{ key: number; label: string | null }>;
  /** the person's manager_id (in or outside the chart), null = none */
  managerOf: (id: number) => number | null;
  collapsed: ReadonlySet<number>;
  /** sort key that keeps the teams of one manager grouped (e.g. department order); ties keep the input order */
  orderOf?: (id: number) => number;
  /** cross company reference cards: one per key, grouped in a frame per (group, frame), in the order given */
  refs?: ReadonlyArray<{ key: string; group: number; frame: string; level: OrgLevel }>;
}

export interface LayoutRef {
  x: number;
  y: number;
  row: number;
  group: number;
  frame: string;
}
export interface LayoutRefFrame {
  key: number;
  frame: string;
  refs: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutNode {
  x: number;
  y: number;
  /** band index (level − 1, or lower when the reporting line forces it) */
  row: number;
  /** placed in a Staff / Admin block (gridRow = row inside the block) */
  grid: { parent: number; gridRow: number; col: number } | null;
  orphan: boolean;
  /** the manager is outside this company / chart: the card sits in that manager's frame */
  external: number | null;
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

/** people of one company whose manager (manager_id) is outside it: one frame, no line to the manager */
export interface LayoutExternal extends LayoutOrphans {
  manager: number;
}

export interface OrgLayout {
  nodes: Map<number, LayoutNode>;
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  orphans: LayoutOrphans[];
  externals: LayoutExternal[];
  /** cross company reference cards (not nodes) and their frames */
  refs: Map<string, LayoutRef>;
  refFrames: LayoutRefFrame[];
  /** the five level bands (top of the cards of that level), always L1–L5 */
  bands: Array<{ level: OrgLevel; y: number }>;
  /** cards and frames */
  bounds: { x: number; y: number; w: number; h: number };
}

/** Columns of a Staff / Admin block of n people: 1–3 → 1, 4–6 → 2, 7+ → 3. */
export function staffCols(n: number): number {
  return Math.max(1, Math.min(GRID_COLS, Math.ceil(n / 3)));
}

/** Width of a Staff / Admin block of n cards (with the spine margins when it has more than one row). */
export function gridWidth(n: number): number {
  const cols = staffCols(n);
  const rows = Math.ceil(n / cols);
  return cols * CARD_W + (cols - 1) * GRID_GAP_X + (rows > 1 ? 2 * SPINE : 0);
}

type Pt = [number, number];
interface Sink { nodes: Map<number, LayoutNode>; edges: LayoutEdge[] }
/** a child of a manager (a subtree or a staff block) with its own origin; `ax` = where its line arrives */
interface Item { w: number; h: number; row: number; ax: number; emit: (sink: Sink, dx: number, dy: number, prefix: Pt[] | null) => void }

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

/** items side by side; `cx` = the centre over the first and last arrival points */
function rowOfItems(items: Item[]) {
  const xs: number[] = [];
  let x = 0;
  for (const it of items) {
    xs.push(x);
    x += it.w + GAP_X;
  }
  const w = items.length ? x - GAP_X : 0;
  const mid = items.length ? ((xs[0] as number) + (items[0] as Item).ax + (xs[xs.length - 1] as number) + (items[items.length - 1] as Item).ax) / 2 : 0;
  return { xs, w, mid };
}

export function layoutOrg(o: LayoutOptions): OrgLayout {
  const { forest, levelOf, collapsed } = o;
  const node = (id: number) => forest.nodes.get(id);
  const order = o.orderOf ?? (() => 0);
  const sorted = (ids: readonly number[]) => ids.map((id, i) => ({ id, i })).sort((a, b) => order(a.id) - order(b.id) || a.i - b.i).map((x) => x.id);
  const kidsShown = (id: number) => (collapsed.has(id) ? [] : sorted(node(id)?.children ?? []));

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

  /** a staff block; parent null = no lines (people in a frame) */
  const gridItem = (parent: number | null, ids: number[], context: boolean, mark: Partial<LayoutNode>): Item => {
    const n = ids.length;
    const cols = staffCols(n);
    const rows = Math.ceil(n / cols);
    const margin = rows > 1 ? SPINE : 0;
    const w = gridWidth(n);
    const base = Math.min(...ids.map(rowOf));
    return {
      w, h: rows * CARD_H + (rows - 1) * GRID_GAP_Y, row: base, ax: w / 2,
      emit: (sink, dx, dy, prefix) => {
        const feed = prefix ? (prefix[prefix.length - 1] as Pt) : null;
        const spineX = dx + margin / 2;
        ids.forEach((k, i) => {
          const gr = Math.floor(i / cols);
          const col = i % cols;
          const inRow = Math.min(cols, n - gr * cols);
          const x = dx + margin + ((cols - inRow) * (CARD_W + GRID_GAP_X)) / 2 + col * (CARD_W + GRID_GAP_X);
          const ty = dy + gr * (CARD_H + GRID_GAP_Y);
          const kcx = x + CARD_W / 2;
          sink.nodes.set(k, { x, y: ty, row: mark.orphan ? levelOf(k) - 1 : rowOf(k), grid: parent === null ? null : { parent, gridRow: gr, col }, orphan: false, external: null, ...mark });
          if (!feed || !prefix || parent === null) return;
          const busY = ty - GRID_GAP_Y / 2;
          sink.edges.push({
            from: parent, to: k, context,
            points: simplify(gr === 0 ? [...prefix, [kcx, feed[1]], [kcx, ty]] : [...prefix, [spineX, feed[1]], [spineX, busY], [kcx, busY], [kcx, ty]]),
          });
        });
      },
    };
  };

  /** the teams under `parent` (subtrees and one staff block in the middle); parent null = a frame of roots */
  const teams = (parent: number | null, ids: number[], context: boolean, mark: Partial<LayoutNode>): Item[] => {
    const branches: Item[] = ids.filter((k) => !gridable(k)).map((k) => subtree(k, mark));
    const staff = ids.filter(gridable);
    // the staff block sits in the middle of the manager's other teams (balanced)
    if (staff.length) branches.splice(Math.floor(branches.length / 2), 0, gridItem(parent, staff, context, mark));
    return branches;
  };

  /** the subtree of `id` as an item (recursion depth = reporting depth) */
  function subtree(id: number, mark: Partial<LayoutNode>): Item {
    const context = forest.context.has(id);
    const me = rowOf(id);
    const items = teams(id, kidsShown(id), context, {});
    const { xs, w: itemsW, mid } = rowOfItems(items);
    const cardMid = items.length ? mid : CARD_W / 2;
    const shift = Math.max(0, CARD_W / 2 - cardMid);
    const w = Math.max(itemsW + shift, cardMid + shift + CARD_W / 2);
    const cx = cardMid + shift;
    const h = Math.max(CARD_H, ...items.map((it) => (it.row - me) * ROW_H + it.h));
    return {
      w, h, row: me, ax: cx,
      emit: (sink, dx, dy, prefix) => {
        sink.nodes.set(id, { x: dx + cx - CARD_W / 2, y: dy, row: me, grid: null, orphan: false, external: null, ...mark });
        if (prefix) {
          const feed = prefix[prefix.length - 1] as Pt;
          const from = forest.nodes.get(id)?.parent as number;
          sink.edges.push({ from, to: id, context: forest.context.has(from), points: simplify([...prefix, [dx + cx, feed[1]], [dx + cx, dy]]) });
        }
        const bus: Pt[] = [[dx + cx, dy + CARD_H], [dx + cx, dy + CARD_H + GAP_Y / 2]];
        items.forEach((it, i) => it.emit(sink, dx + shift + (xs[i] as number), dy + (it.row - me) * ROW_H, bus));
      },
    };
  }

  /** a titled frame around items without a card on top (external manager / no reporting line) */
  interface Unit { w: number; top: number; bottom: number; size: number; put: (sink: Sink, x: number, cardsTop: number) => void }
  const frameUnit = (items: Item[], ids: number[], onFrame: (x: number, y: number, w: number, h: number) => void): Unit => {
    const { xs, w: itemsW } = rowOfItems(items);
    const base = Math.min(...items.map((it) => it.row));
    const top = base * ROW_H - FRAME_TITLE - FRAME_PAD;
    const bottom = Math.max(...items.map((it) => it.row * ROW_H + it.h)) + FRAME_PAD;
    return {
      w: itemsW + 2 * FRAME_PAD, top, bottom, size: ids.length,
      put: (sink, x, cardsTop) => {
        items.forEach((it, i) => it.emit(sink, x + FRAME_PAD + (xs[i] as number), cardsTop + it.row * ROW_H, null));
        onFrame(x, cardsTop + top, itemsW + 2 * FRAME_PAD, bottom - top);
      },
    };
  };
  const count = (id: number): number => 1 + kidsShown(id).reduce((a, k) => a + count(k), 0);

  const sink: Sink = { nodes: new Map(), edges: [] };
  const groups: LayoutGroup[] = [];
  const orphanBlocks: LayoutOrphans[] = [];
  const externals: LayoutExternal[] = [];
  const refs = new Map<string, LayoutRef>();
  const refFrames: LayoutRefFrame[] = [];
  /** a frame of reference cards: by band, at most GRID_COLS per row, a row never above its band nor over the row above */
  const refUnit = (group: number, frame: string, list: ReadonlyArray<{ key: string; level: OrgLevel }>): Unit => {
    const byRow = new Map<number, string[]>();
    for (const r of list) byRow.set(r.level - 1, [...(byRow.get(r.level - 1) ?? []), r.key]);
    const placed: Array<{ key: string; dx: number; y: number; row: number }> = [];
    let free = -Infinity;
    let maxW = 0;
    for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
      const keys = byRow.get(r) as string[];
      let row = r;
      while (row * ROW_H < free) row++;
      const lines = Math.ceil(keys.length / GRID_COLS);
      keys.forEach((key, i) => {
        const line = Math.floor(i / GRID_COLS);
        const col = i % GRID_COLS;
        const inLine = Math.min(GRID_COLS, keys.length - line * GRID_COLS);
        placed.push({ key, dx: ((Math.min(GRID_COLS, keys.length) - inLine) * (CARD_W + GRID_GAP_X)) / 2 + col * (CARD_W + GRID_GAP_X), y: row * ROW_H + line * (CARD_H + GRID_GAP_Y), row });
      });
      maxW = Math.max(maxW, Math.min(GRID_COLS, keys.length) * (CARD_W + GRID_GAP_X) - GRID_GAP_X);
      free = row * ROW_H + lines * (CARD_H + GRID_GAP_Y) - GRID_GAP_Y + GAP_Y;
    }
    const top = Math.min(...placed.map((p) => p.y)) - FRAME_TITLE - FRAME_PAD;
    const bottom = Math.max(...placed.map((p) => p.y + CARD_H)) + FRAME_PAD;
    return {
      w: maxW + 2 * FRAME_PAD, top, bottom, size: 0,
      put: (_s, x, ct) => {
        for (const p of placed) refs.set(p.key, { x: x + FRAME_PAD + p.dx, y: ct + p.y, row: p.row, group, frame });
        refFrames.push({ key: group, frame, refs: placed.map((p) => p.key), x, y: ct + top, w: maxW + 2 * FRAME_PAD, h: bottom - top });
      },
    };
  };
  const anyHeader = o.groups.some((g) => g.label !== null);
  const cardsTop = MARGIN + (anyHeader ? HEADER_H : 0) + TOP_PAD;
  let cursorX = 0;
  let maxBottom = cardsTop;
  for (const g of o.groups) {
    const roots = forest.roots.filter((r) => o.groupOf(r) === g.key);
    if (!roots.length) continue;
    const cls = (r: number): 'tree' | 'orphan' | 'external' => {
      const n = node(r);
      if (!n || n.cycle || n.context) return 'tree';
      if (o.managerOf(r) !== null) return 'external';
      return n.children.length ? 'tree' : 'orphan';
    };
    const trees: Unit[] = roots.filter((r) => cls(r) === 'tree').map((r) => {
      const it = subtree(r, {});
      return { w: it.w, top: it.row * ROW_H, bottom: it.row * ROW_H + it.h, size: count(r), put: (s, x, ct) => it.emit(s, x, ct + it.row * ROW_H, null) };
    });
    const byManager = new Map<number, number[]>();
    for (const r of roots) if (cls(r) === 'external') byManager.set(o.managerOf(r) as number, [...(byManager.get(o.managerOf(r) as number) ?? []), r]);
    const exts: Unit[] = [...byManager.entries()].map(([manager, ids]) => {
      const ordered = sorted(ids);
      return frameUnit(teams(null, ordered, false, { external: manager }), ordered, (x, y, w, h) => externals.push({ key: g.key, manager, ids: ordered, x, y, w, h }));
    });
    const orphanIds = sorted(roots.filter((r) => cls(r) === 'orphan'));
    const orphanUnit = orphanIds.length
      ? frameUnit([gridItem(null, orphanIds, false, { orphan: true })], orphanIds,
        (x, y, w, h) => orphanBlocks.push({ key: g.key, ids: orphanIds, x, y, w, h }))
      : null;

    // largest tree in the centre, the rest balanced left / right, the "no reporting line" block at the right end
    const units = [...trees].sort((a, b) => b.size - a.size);
    const centre = units.shift();
    const rest = [...units, ...exts.sort((a, b) => b.size - a.size)];
    const left: Unit[] = [];
    const right: Unit[] = [];
    const width = (us: Unit[]) => us.reduce((a, u) => a + u.w + UNIT_GAP, 0);
    for (const u of rest) (width(left) <= width(right) ? left : right).push(u);
    // cross company references of this company: one frame per target department / team, at the left end
    const frameKeys: string[] = [];
    for (const r of o.refs ?? []) if (r.group === g.key && !frameKeys.includes(r.frame)) frameKeys.push(r.frame);
    const refUnits = frameKeys.map((f) => refUnit(g.key, f, [...new Map((o.refs ?? []).filter((r) => r.group === g.key && r.frame === f).map((r) => [r.key, r])).values()]));
    const line = [...refUnits, ...left.reverse(), ...(centre ? [centre] : []), ...right, ...(orphanUnit ? [orphanUnit] : [])];
    const innerW = line.reduce((a, u) => a + u.w, 0) + UNIT_GAP * Math.max(0, line.length - 1);
    let x = cursorX;
    let bottom = cardsTop;
    for (const u of line) {
      u.put(sink, x, cardsTop);
      bottom = Math.max(bottom, cardsTop + u.bottom);
      x += u.w + UNIT_GAP;
    }
    const gy = MARGIN;
    groups.push({ key: g.key, label: g.label, x: cursorX - 16, y: gy, w: innerW + 32, h: bottom + 16 - gy });
    maxBottom = Math.max(maxBottom, bottom + 16);
    cursorX += innerW + GROUP_GAP;
  }

  const bands = LEVELS.map((level) => ({ level, y: cardsTop + (level - 1) * ROW_H }));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of sink.nodes.values()) {
    xs.push(n.x, n.x + CARD_W);
    ys.push(n.y, n.y + CARD_H);
  }
  for (const r of refs.values()) {
    xs.push(r.x, r.x + CARD_W);
    ys.push(r.y, r.y + CARD_H);
  }
  for (const f of [...orphanBlocks, ...externals, ...refFrames, ...groups.filter((g) => g.label !== null)]) {
    xs.push(f.x, f.x + f.w);
    ys.push(f.y, f.y + f.h);
  }
  const minX = (xs.length ? Math.min(...xs) : 0) - MARGIN;
  const maxX = (xs.length ? Math.max(...xs) : CARD_W) + MARGIN;
  // External-manager reference cards are drawn above their team frames by the chart renderer.
  const minY = Math.min(0, ...externals.map((f) => f.y - CARD_H - 24));
  const maxY = Math.max(ys.length ? Math.max(...ys) : CARD_H, (bands[4] as { y: number }).y + CARD_H) + MARGIN;
  return { nodes: sink.nodes, edges: sink.edges, groups, orphans: orphanBlocks, externals, refs, refFrames, bands, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}
