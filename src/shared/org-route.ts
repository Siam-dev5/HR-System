// Orthogonal routing of the cross company (dashed) relationship lines of the organization chart: pure geometry, no
// DOM (unit-tested). A* over a fine grid of the free space, with every card as an obstacle (a margin around it), so a
// line never crosses a card; turns cost extra (few bends) and cells taken by an earlier line cost extra (lines do not
// pile up on each other when a person has several assignments). A line leaves / enters a card at the middle of a side
// or at a quarter of the top / bottom edge (clear of the reporting-line connectors at the top / bottom centre). The
// solid reporting lines may be passed as `soft`: crossing one is cheap, running along one is expensive, so a dashed
// line is never drawn on top of a solid one where it need not.

export interface Rect { x: number; y: number; w: number; h: number }
export type Pt = [number, number];

const CELL = 6;
/** free margin kept around every card */
const PAD = 4;
const TURN = 8;
const SHARED = 5;
/** per cell on a solid reporting line */
const ALONG = 3;
/** extra room around the chart for lines that go round the outside */
const OUTSIDE = 72;

interface Port { gx: number; gy: number; dir: number; anchor: (x: number, y: number) => Pt }
// directions: 0 right, 1 down, 2 left, 3 up
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

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

/** min-heap of (priority, state) */
class Heap {
  private p: number[] = [];
  private s: number[] = [];
  get size() { return this.s.length; }
  push(pr: number, st: number) {
    const { p, s } = this;
    let i = s.length;
    p.push(pr);
    s.push(st);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if ((p[j] as number) <= pr) break;
      p[i] = p[j] as number;
      s[i] = s[j] as number;
      i = j;
    }
    p[i] = pr;
    s[i] = st;
  }
  pop(): number {
    const { p, s } = this;
    const top = s[0] as number;
    const lp = p.pop() as number;
    const ls = s.pop() as number;
    if (s.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= s.length) break;
        const r = l + 1;
        const c = r < s.length && (p[r] as number) < (p[l] as number) ? r : l;
        if ((p[c] as number) >= lp) break;
        p[i] = p[c] as number;
        s[i] = s[c] as number;
        i = c;
      }
      p[i] = lp;
      s[i] = ls;
    }
    return top;
  }
}

/**
 * Routes each link between two card rectangles. `obstacles` = every card on the chart (the link's own two cards
 * included). Returns one orthogonal polyline per link (first point on the `from` card's edge, last on the `to`
 * card's edge), or null when no free path exists.
 */
export function routeLinks(obstacles: readonly Rect[], links: ReadonlyArray<{ from: Rect; to: Rect }>, soft: ReadonlyArray<readonly Pt[]> = []): Array<Pt[] | null> {
  if (!links.length) return [];
  const all = [...obstacles, ...links.flatMap((l) => [l.from, l.to])];
  const ox = Math.min(...all.map((r) => r.x)) - OUTSIDE;
  const oy = Math.min(...all.map((r) => r.y)) - OUTSIDE;
  const cols = Math.ceil((Math.max(...all.map((r) => r.x + r.w)) + OUTSIDE - ox) / CELL) + 1;
  const rows = Math.ceil((Math.max(...all.map((r) => r.y + r.h)) + OUTSIDE - oy) / CELL) + 1;
  const blocked = new Uint8Array(cols * rows);
  const used = new Uint8Array(cols * rows);
  const cx = (gx: number) => ox + gx * CELL;
  const cy = (gy: number) => oy + gy * CELL;
  for (const r of obstacles) {
    const x0 = Math.max(0, Math.ceil((r.x - PAD - ox) / CELL));
    const x1 = Math.min(cols - 1, Math.floor((r.x + r.w + PAD - ox) / CELL));
    const y0 = Math.max(0, Math.ceil((r.y - PAD - oy) / CELL));
    const y1 = Math.min(rows - 1, Math.floor((r.y + r.h + PAD - oy) / CELL));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) blocked[gy * cols + gx] = 1;
  }
  // cells on (and right next to) a solid line
  const near = new Uint8Array(cols * rows);
  for (const line of soft) {
    for (let k = 1; k < line.length; k++) {
      const [a, b] = [line[k - 1] as Pt, line[k] as Pt];
      const gx0 = Math.round((Math.min(a[0], b[0]) - ox) / CELL);
      const gx1 = Math.round((Math.max(a[0], b[0]) - ox) / CELL);
      const gy0 = Math.round((Math.min(a[1], b[1]) - oy) / CELL);
      const gy1 = Math.round((Math.max(a[1], b[1]) - oy) / CELL);
      for (let gy = gy0 - 1; gy <= gy1 + 1; gy++) for (let gx = gx0 - 1; gx <= gx1 + 1; gx++) if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) near[gy * cols + gx] = 1;
    }
  }
  const free = (gx: number, gy: number) => gx >= 0 && gy >= 0 && gx < cols && gy < rows && !blocked[gy * cols + gx];

  /** the four exits of a card: a free cell just outside the edge, and the matching point on the edge */
  const ports = (r: Rect): Port[] => {
    const out: Port[] = [];
    const add = (px: number, py: number, dir: number, anchor: Port['anchor']) => {
      let gx = Math.round((px - ox) / CELL);
      let gy = Math.round((py - oy) / CELL);
      for (let k = 0; k < 6 && !free(gx, gy); k++) {
        gx += DX[dir] as number;
        gy += DY[dir] as number;
      }
      if (free(gx, gy)) out.push({ gx, gy, dir, anchor });
    };
    const midY = r.y + r.h / 2;
    add(r.x + r.w + PAD + CELL, midY, 0, (_x, y) => [r.x + r.w, y]);
    add(r.x - PAD - CELL, midY, 2, (_x, y) => [r.x, y]);
    add(r.x + r.w * 0.75, r.y - PAD - CELL, 3, (x) => [x, r.y]);
    add(r.x + r.w * 0.25, r.y + r.h + PAD + CELL, 1, (x) => [x, r.y + r.h]);
    // the anchor must stay on the edge (a port snapped past a corner is dropped)
    return out.filter((p) => {
      const [ax, ay] = p.anchor(cx(p.gx), cy(p.gy));
      return ax >= r.x && ax <= r.x + r.w && ay >= r.y && ay <= r.y + r.h;
    });
  };

  /** A* inside the columns [wx0, wx1] (all rows); null when there is no path there */
  const search = (starts: Port[], goals: Port[], wx0: number, wx1: number): number[] | null => {
    const wc = wx1 - wx0 + 1;
    const g = new Float32Array(wc * rows * 4).fill(Infinity);
    const prev = new Int32Array(wc * rows * 4).fill(-1);
    const local = (gx: number, gy: number) => gy * wc + (gx - wx0);
    const goalAt = new Set(goals.filter((p) => p.gx >= wx0 && p.gx <= wx1).map((p) => local(p.gx, p.gy)));
    if (!goalAt.size) return null;
    const h = (gx: number, gy: number) => Math.min(...goals.map((p) => Math.abs(p.gx - gx) + Math.abs(p.gy - gy)));
    const heap = new Heap();
    for (const s of starts) {
      if (s.gx < wx0 || s.gx > wx1) continue;
      const st = local(s.gx, s.gy) * 4 + s.dir;
      g[st] = 0;
      heap.push(h(s.gx, s.gy), st);
    }
    let end = -1;
    while (heap.size) {
      const st = heap.pop();
      const cell = st >> 2;
      const dir = st & 3;
      if (goalAt.has(cell)) {
        end = st;
        break;
      }
      const lx = cell % wc;
      const gy = (cell - lx) / wc;
      const gx = lx + wx0;
      const base = g[st] as number;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((dir + 2) & 3)) continue;
        const nx = gx + (DX[nd] as number);
        const ny = gy + (DY[nd] as number);
        if (nx < wx0 || nx > wx1 || !free(nx, ny)) continue;
        const cost = base + 1 + (nd === dir ? 0 : TURN) + (used[ny * cols + nx] ? SHARED : 0) + (near[ny * cols + nx] ? ALONG : 0);
        const ns = local(nx, ny) * 4 + nd;
        if (cost < (g[ns] as number)) {
          g[ns] = cost;
          prev[ns] = st;
          heap.push(cost + h(nx, ny), ns);
        }
      }
    }
    if (end < 0) return null;
    const cells: number[] = [];
    for (let st = end; st >= 0; st = prev[st] as number) {
      const lc = st >> 2;
      const lx = lc % wc;
      cells.push(((lc - lx) / wc) * cols + lx + wx0);
    }
    return cells.reverse();
  };

  return links.map(({ from, to }) => {
    const starts = ports(from);
    const goals = ports(to);
    if (!starts.length || !goals.length) return null;
    // a window around both cards first (fast on a wide chart), the whole chart if that fails
    const room = 60;
    const wx0 = Math.max(0, Math.min(...[...starts, ...goals].map((p) => p.gx)) - room);
    const wx1 = Math.min(cols - 1, Math.max(...[...starts, ...goals].map((p) => p.gx)) + room);
    const cells = search(starts, goals, wx0, wx1) ?? (wx0 > 0 || wx1 < cols - 1 ? search(starts, goals, 0, cols - 1) : null);
    if (!cells) return null;
    for (const c of cells) used[c] = 1;
    const first = cells[0] as number;
    const last = cells[cells.length - 1] as number;
    const sp = starts.find((p) => p.gy * cols + p.gx === first) as Port;
    const gp = goals.find((p) => p.gy * cols + p.gx === last) as Port;
    const pts: Pt[] = cells.map((c) => [cx(c % cols), cy(Math.floor(c / cols))]);
    return simplify([sp.anchor(cx(sp.gx), cy(sp.gy)), ...pts, gp.anchor(cx(gp.gx), cy(gp.gy))]);
  });
}

/** whether an axis-aligned segment enters the inside of a rectangle (touching its edge does not count) */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect, inset = 1): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return x1 > r.x + inset && x0 < r.x + r.w - inset && y1 > r.y + inset && y0 < r.y + r.h - inset;
}
