import { describe, expect, it } from 'vitest';
import { buildOrgForest, mergeForests, type OrgForest } from '../../src/shared/org-tree';
import { POSITION_LEVELS, positionLevel, type OrgLevel } from '../../src/shared/org-levels';
import { CARD_H, CARD_W, GRID_COLS, layoutOrg, staffCols, type OrgLayout } from '../../src/shared/org-layout';
import { DEPT_COLORS, NO_DEPT_COLOR, contrast, departmentColors } from '../../src/shared/org-colors';

// Synthetic people only (no production data): id, manager, company, position title.
interface P { id: number; manager_id: number | null; department_id: number | null; company_id: number; title: string }

let seq = 0;
function person(title: string, manager: P | null, company = 1, dept: number | null = 1): P {
  return { id: ++seq, manager_id: manager?.id ?? null, department_id: dept, company_id: company, title };
}

function layout(people: P[], opts: { collapsed?: number[]; companies?: number[]; labels?: boolean; include?: (p: P) => boolean; byDept?: boolean } = {}) {
  const companies = opts.companies ?? [...new Set(people.map((p) => p.company_id))];
  const include = opts.include ?? (() => true);
  const forest = mergeForests(companies.map((c) => buildOrgForest(people.filter((p) => p.company_id === c), include)));
  const byId = new Map(people.map((p) => [p.id, p]));
  const lay = layoutOrg({
    forest,
    levelOf: (id) => positionLevel(byId.get(id)?.title).level,
    groupOf: (id) => byId.get(id)?.company_id ?? 0,
    groups: companies.map((c) => ({ key: c, label: opts.labels ? `Company ${c}` : null })),
    managerOf: (id) => byId.get(id)?.manager_id ?? null,
    collapsed: new Set(opts.collapsed ?? []),
    orderOf: opts.byDept ? (id) => byId.get(id)?.department_id ?? 1e9 : undefined,
  });
  return { forest, lay };
}

type Rect = { l: number; t: number; r: number; b: number };
const rect = (n: { x: number; y: number }): Rect => ({ l: n.x, t: n.y, r: n.x + CARD_W, b: n.y + CARD_H });
const box = (f: { x: number; y: number; w: number; h: number }): Rect => ({ l: f.x, t: f.y, r: f.x + f.w, b: f.y + f.h });
const overlap = (a: Rect, b: Rect) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const inside = (a: Rect, b: Rect) => a.l >= b.l && a.r <= b.r && a.t >= b.t && a.b <= b.b;
const cx = (lay: OrgLayout, id: number) => (lay.nodes.get(id)?.x ?? NaN) + CARD_W / 2;

/** Geometry invariants that every layout must keep. */
function checkInvariants(forest: OrgForest, lay: OrgLayout, collapsed: number[] = []) {
  const hidden = new Set<number>();
  for (const c of collapsed) {
    const stack = [...(forest.nodes.get(c)?.children ?? [])];
    while (stack.length) {
      const k = stack.pop() as number;
      hidden.add(k);
      stack.push(...(forest.nodes.get(k)?.children ?? []));
    }
  }
  // every visible person placed exactly once (Map keys are unique), nobody hidden or invented
  const expected = [...forest.nodes.keys()].filter((id) => !hidden.has(id)).sort((a, b) => a - b);
  expect([...lay.nodes.keys()].sort((a, b) => a - b)).toEqual(expected);

  // no two cards overlap
  const all = [...lay.nodes.entries()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [ia, a] = all[i] as [number, { x: number; y: number }];
      const [ib, b] = all[j] as [number, { x: number; y: number }];
      expect(overlap(rect(a), rect(b)), `cards ${ia} and ${ib} overlap`).toBe(false);
    }
  }

  // one edge per shown report, from its real manager (forest parent), never re-parented
  for (const [id] of lay.nodes) {
    const parent = forest.nodes.get(id)?.parent ?? null;
    const into = lay.edges.filter((e) => e.to === id);
    if (parent === null) expect(into).toHaveLength(0);
    else {
      expect(into).toHaveLength(1);
      expect(into[0]?.from).toBe(parent);
      // the report sits below its manager
      expect((lay.nodes.get(id)?.y ?? 0)).toBeGreaterThan((lay.nodes.get(parent)?.y ?? 0) + CARD_H);
    }
  }

  // connectors are orthogonal and never run through a card other than their own two ends
  for (const e of lay.edges) {
    for (let k = 1; k < e.points.length; k++) {
      const [x1, y1] = e.points[k - 1] as [number, number];
      const [x2, y2] = e.points[k] as [number, number];
      expect(x1 === x2 || y1 === y2, 'orthogonal segment').toBe(true);
      const seg: Rect = { l: Math.min(x1, x2), r: Math.max(x1, x2), t: Math.min(y1, y2), b: Math.max(y1, y2) };
      for (const [id, n] of lay.nodes) {
        if (id === e.from || id === e.to) continue;
        const c = rect(n);
        // a vertical / horizontal segment against the card's open interior
        const crosses = x1 === x2
          ? c.l < x1 && x1 < c.r && seg.t < c.b && seg.b > c.t
          : c.t < y1 && y1 < c.b && seg.l < c.r && seg.r > c.l;
        expect(crosses, `edge ${e.from}->${e.to} crosses card ${id}`).toBe(false);
      }
    }
  }

  // Staff / Admin blocks: ≤ 3 per row, one manager per block, last row centred under the block
  const grids = new Map<number, Map<number, number[]>>();
  for (const [id, n] of lay.nodes) {
    if (!n.grid) continue;
    expect(n.grid.parent).toBe(forest.nodes.get(id)?.parent);
    const rows = grids.get(n.grid.parent) ?? new Map<number, number[]>();
    rows.set(n.grid.gridRow, [...(rows.get(n.grid.gridRow) ?? []), id]);
    grids.set(n.grid.parent, rows);
  }
  for (const rows of grids.values()) {
    const centre = (ids: number[]) => ids.reduce((a, id) => a + (lay.nodes.get(id)?.x ?? 0), 0) / ids.length;
    const first = rows.get(0) as number[];
    for (const [, ids] of rows) {
      expect(ids.length).toBeLessThanOrEqual(GRID_COLS);
      expect(Math.abs(centre(ids) - centre(first))).toBeLessThan(0.01);
    }
  }

  // frames (external manager / no reporting line): hold exactly their people, never overlap another card or frame
  const frames = [...lay.externals, ...lay.orphans];
  for (const f of frames) {
    for (const [id, n] of lay.nodes) {
      const mine = f.ids.includes(id) || isUnder(forest, id, f.ids);
      if (mine) expect(inside(rect(n), box(f)), `card ${id} inside its frame`).toBe(true);
      else expect(overlap(rect(n), box(f)), `card ${id} overlaps a frame`).toBe(false);
    }
  }
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) expect(overlap(box(frames[i] as never), box(frames[j] as never))).toBe(false);
  for (const id of lay.orphans.flatMap((f) => f.ids)) expect(lay.nodes.get(id)?.orphan).toBe(true);
  for (const f of lay.externals) for (const id of f.ids) expect(lay.nodes.get(id)?.external).toBe(f.manager);

  // the five level bands, top-down, and every card at its own band (or lower when its manager forces it)
  expect(lay.bands.map((b) => b.level)).toEqual([1, 2, 3, 4, 5]);
  const b0 = (lay.bands[0] as { y: number }).y;
  const rowH = (lay.bands[1] as { y: number }).y - b0;
  for (const [id, n] of lay.nodes) {
    const bandY = b0 + n.row * rowH;
    // first row of a block (or a tree card) sits exactly on its band; further block rows below it
    const blockRow = (n.grid && n.grid.gridRow > 0) || ((n.orphan || n.external !== null) && !forest.nodes.get(id)?.children.length);
    if (blockRow) expect(n.y).toBeGreaterThanOrEqual(bandY);
    else expect(n.y, `card ${id} on its band`).toBe(bandY);
  }
  return lay;
}
function isUnder(forest: OrgForest, id: number, roots: number[]): boolean {
  let p = forest.nodes.get(id)?.parent ?? null;
  while (p !== null) {
    if (roots.includes(p)) return true;
    p = forest.nodes.get(p)?.parent ?? null;
  }
  return false;
}

const gridRows = (lay: OrgLayout, parent: number) => {
  const rows = new Map<number, number>();
  for (const n of lay.nodes.values()) if (n.grid?.parent === parent) rows.set(n.grid.gridRow, (rows.get(n.grid.gridRow) ?? 0) + 1);
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
};
const staff = (n: number, mgr: P, title = 'Customer Service Officer', company = 1, dept: number | null = 1) => Array.from({ length: n }, () => person(title, mgr, company, dept));

describe('position title → level (exact production mapping)', () => {
  it('maps every approved production title, 26 in total', () => {
    expect(Object.keys(POSITION_LEVELS)).toHaveLength(26);
    const count = (l: OrgLevel) => Object.values(POSITION_LEVELS).filter((x) => x === l).length;
    expect([count(1), count(2), count(3), count(4), count(5)]).toEqual([1, 1, 4, 6, 14]);
    expect(positionLevel('Manager Director')).toEqual({ level: 1, mapped: true });
    expect(positionLevel('Asst. Managing Director')).toEqual({ level: 2, mapped: true });
    expect(positionLevel('Partners Manager')).toEqual({ level: 3, mapped: true });
    expect(positionLevel('HR Leader (Payroll & Admin)')).toEqual({ level: 4, mapped: true });
    expect(positionLevel('Business Development')).toEqual({ level: 5, mapped: true });
  });

  it('never guesses from keywords or grades: an unknown title is L5 and marked unmapped', () => {
    for (const t of ['Sales Manager', 'Managing Director', 'Team Leader', 'กรรมการผู้จัดการ', 'manager director', '', null, undefined]) {
      expect(positionLevel(t)).toEqual({ level: 5, mapped: false });
    }
  });

  it('ignores only leading / trailing spaces', () => {
    expect(positionLevel('  Sales Leader ')).toEqual({ level: 4, mapped: true });
    expect(positionLevel('Sales  Leader')).toEqual({ level: 5, mapped: false });
  });
});

describe('organization layout (master template)', () => {
  it('1. a small company: MD on top, two staff stacked in one column centred under it', () => {
    const md = person('Manager Director', null);
    const s = staff(2, md);
    const { forest, lay } = layout([md, ...s]);
    checkInvariants(forest, lay);
    expect(lay.nodes.get(md.id)?.row).toBe(0);
    expect(gridRows(lay, md.id)).toEqual([1, 1]);
    // staff sit in the L5 band even though they report straight to the MD
    expect(lay.nodes.get(s[0]?.id as number)?.row).toBe(4);
    expect(Math.abs(cx(lay, md.id) - cx(lay, s[0]?.id as number))).toBeLessThan(0.01);
  });

  it('master template: the MD centred over the AMDs, every AMD centred over its managers, teams side by side', () => {
    const md = person('Manager Director', null);
    const people: P[] = [md];
    const amds = [1, 2, 3].map((d) => person('Asst. Managing Director', md, 1, d));
    const mgrs: P[][] = [];
    amds.forEach((a, i) => {
      people.push(a);
      const ms = [0, 1, 2].map(() => person('Operations Manager', a, 1, i + 1));
      mgrs.push(ms);
      for (const m of ms) people.push(m, ...staff(3, m, 'Operations Officer', 1, i + 1));
    });
    const { forest, lay } = layout(people);
    checkInvariants(forest, lay);
    // spread, not stacked: all AMDs share one row, all nine managers share the next band
    expect(new Set(amds.map((a) => lay.nodes.get(a.id)?.y)).size).toBe(1);
    expect(new Set(mgrs.flat().map((m) => lay.nodes.get(m.id)?.y)).size).toBe(1);
    // left / centre / right
    const xs = amds.map((a) => cx(lay, a.id));
    expect(xs[0]).toBeLessThan(xs[1] as number);
    expect(xs[1]).toBeLessThan(xs[2] as number);
    expect(Math.abs(cx(lay, md.id) - ((xs[0] as number) + (xs[2] as number)) / 2)).toBeLessThan(0.01);
    amds.forEach((a, i) => {
      const ms = mgrs[i] as P[];
      expect(Math.abs(cx(lay, a.id) - (cx(lay, (ms[0] as P).id) + cx(lay, (ms[2] as P).id)) / 2)).toBeLessThan(0.01);
    });
    // each AMD's team keeps its own column range (no interleaving between divisions)
    const range = (i: number) => {
      const ids = [amds[i] as P, ...(mgrs[i] as P[])].flatMap((m) => [m.id, ...people.filter((p) => p.manager_id === m.id).map((p) => p.id)]);
      const x = ids.map((id) => lay.nodes.get(id)?.x ?? 0);
      return [Math.min(...x), Math.max(...x) + CARD_W];
    };
    expect((range(0)[1] as number)).toBeLessThan(range(1)[0] as number);
    expect((range(1)[1] as number)).toBeLessThan(range(2)[0] as number);
  });

  it('2. several departments, managers and leaders: one band per level, top narrower than the bottom', () => {
    const md = person('Manager Director', null);
    const amd = person('Asst. Managing Director', md);
    const people: P[] = [md, amd];
    for (const [mt, lt] of [['Operations Manager', 'Operations Leader'], ['Account Manager', 'Sales Leader'], ['Human Resources Manager', 'HR Leader (Payroll & Admin)']] as const) {
      const m = person(mt, amd);
      people.push(m);
      for (let i = 0; i < 2; i++) {
        const l = person(lt, m);
        people.push(l, ...staff(4 + i * 3, l, 'Operations Officer'));
      }
    }
    const { forest, lay } = layout(people);
    checkInvariants(forest, lay);
    const ids = (lv: OrgLevel) => people.filter((p) => positionLevel(p.title).level === lv).map((p) => p.id);
    const bandY = (lv: OrgLevel) => new Set(ids(lv).map((id) => lay.nodes.get(id)?.y));
    for (const lv of [1, 2, 3, 4] as OrgLevel[]) {
      expect(bandY(lv).size).toBe(1);
      expect([...bandY(lv)][0]).toBe(lay.bands[lv - 1]?.y);
    }
    const span = (lv: OrgLevel) => {
      const xs = ids(lv).map((id) => lay.nodes.get(id)?.x ?? 0);
      return Math.max(...xs) + CARD_W - Math.min(...xs);
    };
    expect(span(1)).toBeLessThanOrEqual(span(3));
    expect(span(3)).toBeLessThanOrEqual(span(4));
    expect(span(4)).toBeLessThanOrEqual(span(5));
  });

  it('staff grouping: 1–3 in one column, 4–6 in two, 7+ in three columns', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9, 10, 30].map(staffCols)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
    for (const [n, rows] of [[1, [1]], [3, [1, 1, 1]], [4, [2, 2]], [5, [2, 2, 1]], [6, [2, 2, 2]], [7, [3, 3, 1]], [8, [3, 3, 2]], [10, [3, 3, 3, 1]], [12, [3, 3, 3, 3]]] as const) {
      const l = person('Operations Leader', null);
      const s = staff(n, l);
      const { forest, lay } = layout([l, ...s]);
      checkInvariants(forest, lay);
      expect(gridRows(lay, l.id)).toEqual(rows);
      const xs = s.map((p) => lay.nodes.get(p.id)?.x ?? 0);
      expect(Math.max(...xs) + CARD_W - Math.min(...xs)).toBeLessThanOrEqual(3 * CARD_W + 2 * 18 + 0.01);
    }
  });

  it('last row centring: a short last row sits in the middle of the block', () => {
    for (const n of [5, 7, 10]) {
      const l = person('Sales Leader', null);
      const s = staff(n, l);
      const { lay } = layout([l, ...s]);
      const rowsOf = new Map<number, number[]>();
      for (const p of s) {
        const g = lay.nodes.get(p.id)?.grid as { gridRow: number };
        rowsOf.set(g.gridRow, [...(rowsOf.get(g.gridRow) ?? []), cx(lay, p.id)]);
      }
      const mid = (xs: number[]) => (Math.min(...xs) + Math.max(...xs)) / 2;
      const last = rowsOf.get(Math.max(...rowsOf.keys())) as number[];
      expect(Math.abs(mid(last) - mid(rowsOf.get(0) as number[]))).toBeLessThan(0.01);
      expect(Math.abs(mid(last) - cx(lay, l.id))).toBeLessThan(0.01);
    }
  });

  it('multiple managers / teams: staff of different managers never share a block', () => {
    const m = person('Operations Manager', null);
    const a = person('Operations Leader', m);
    const b = person('Sales Leader', m);
    const sa = staff(2, a);
    const sb = staff(4, b);
    const { forest, lay } = layout([m, a, b, ...sa, ...sb]);
    checkInvariants(forest, lay);
    expect(gridRows(lay, a.id)).toEqual([1, 1]);
    expect(gridRows(lay, b.id)).toEqual([2, 2]);
  });

  it('a manager with both leaders and direct staff: the staff block sits between the branches', () => {
    const m = person('Operations Manager', null);
    const l1 = person('Operations Leader', m);
    const l2 = person('Sales Leader', m);
    const direct = staff(5, m);
    const { forest, lay } = layout([m, l1, ...staff(3, l1), l2, ...staff(2, l2), ...direct]);
    checkInvariants(forest, lay);
    expect(gridRows(lay, m.id)).toEqual([2, 2, 1]);
    const x = (id: number) => lay.nodes.get(id)?.x ?? 0;
    expect(x(l1.id)).toBeLessThan(x(direct[0]?.id as number));
    expect(x(direct[1]?.id as number)).toBeLessThan(x(l2.id));
  });

  it('Business Development (L5) with reports stays L5; its reports hang below it by manager_id', () => {
    const l = person('Sales Leader', null);
    const bd = person('Business Development', l);
    const peer = person('Business Development', l);
    const reports = staff(4, bd, 'Sales Executive');
    const { forest, lay } = layout([l, bd, peer, ...reports]);
    checkInvariants(forest, lay);
    expect(lay.nodes.get(bd.id)?.row).toBe(4);
    expect(lay.nodes.get(bd.id)?.grid).toBeNull(); // has reports: a branch, not a block card
    expect(lay.nodes.get(peer.id)?.grid?.parent).toBe(l.id);
    expect(gridRows(lay, bd.id)).toEqual([2, 2]);
    for (const r of reports) expect(lay.nodes.get(r.id)?.row).toBe(5);
  });

  it('a leader reporting straight to the AMD skips the Manager band (no invented manager)', () => {
    const amd = person('Asst. Managing Director', null);
    const lead = person('LiveStreaming Team Leader', amd);
    const s = staff(2, lead, 'LiveStreaming');
    const { forest, lay } = layout([amd, lead, ...s]);
    checkInvariants(forest, lay);
    expect(lay.nodes.get(amd.id)?.row).toBe(1);
    expect(lay.nodes.get(lead.id)?.row).toBe(3);
    expect(lay.edges.find((e) => e.to === lead.id)?.from).toBe(amd.id);
  });

  it('no MD / AMD in the data: nothing is invented, the L1 / L2 bands simply stay empty', () => {
    const m = person('Operations Manager', null);
    const people = [m, ...staff(3, m)];
    const { forest, lay } = layout(people);
    checkInvariants(forest, lay);
    expect(lay.nodes.size).toBe(4);
    expect(lay.nodes.get(m.id)?.y).toBe(lay.bands[2]?.y);
  });

  it('unassigned: people without a manager and without reports go to the "no reporting line" block beside the tree', () => {
    const amd = person('Asst. Managing Director', null); // top of the company: has reports, stays the tree root
    const m = person('Operations Manager', amd);
    const loose = [person('LiveStreaming', null, 1, null), person('LiveStreaming', null), person('Quality Control Officer', null)];
    const { forest, lay } = layout([amd, m, ...staff(3, m), ...loose]);
    checkInvariants(forest, lay);
    expect(lay.orphans).toHaveLength(1);
    expect(lay.orphans[0]?.ids).toEqual(loose.map((p) => p.id));
    expect(lay.nodes.get(amd.id)?.orphan).toBe(false);
    // at the right end, on the L5 band
    const treeRight = Math.max(...[amd, m].map((p) => (lay.nodes.get(p.id)?.x ?? 0) + CARD_W));
    expect(lay.orphans[0]?.x).toBeGreaterThan(treeRight);
    expect(lay.nodes.get(loose[0]?.id as number)?.y).toBe(lay.bands[4]?.y);
  });

  it('unmapped position: shown on the L5 band, never dropped, its reporting line kept', () => {
    const l = person('Operations Leader', null);
    const odd = person('Chief Happiness Officer', l);
    const { forest, lay } = layout([l, odd, ...staff(2, l)]);
    checkInvariants(forest, lay);
    expect(positionLevel(odd.title).mapped).toBe(false);
    expect(lay.nodes.get(odd.id)?.row).toBe(4);
    expect(lay.edges.find((e) => e.to === odd.id)?.from).toBe(l.id);
  });

  it('a person whose manager is outside the chart sits in a frame named after that manager, not in "no reporting line"', () => {
    const p = { ...person('Operations Officer', null), manager_id: 9999 };
    const q = { ...person('Operations Officer', null), manager_id: 9999 };
    const { forest, lay } = layout([p, q]);
    checkInvariants(forest, lay);
    expect(lay.orphans).toHaveLength(0);
    expect(lay.externals).toEqual([expect.objectContaining({ manager: 9999, ids: [p.id, q.id] })]);
    expect(lay.edges).toHaveLength(0);
  });

  it('reporting loop: everyone shown once, finite, the cut point is a tree root', () => {
    const a = person('Operations Leader', null);
    const b = person('Operations Leader', a);
    const c = person('Operations Officer', b);
    a.manager_id = b.id; // a ↔ b loop
    const self = person('Sales Executive', null);
    self.manager_id = self.id; // self-reference
    const { forest, lay } = layout([a, b, c, self]);
    checkInvariants(forest, lay);
    expect(lay.nodes.size).toBe(4);
    expect([...forest.nodes.values()].filter((n) => n.cycle)).toHaveLength(1);
    expect(lay.orphans.flatMap((o) => o.ids)).not.toContain(a.id);
    expect(lay.externals.flatMap((o) => o.ids)).not.toContain(a.id);
  });

  it('cross-department reporting: the real line is drawn; teams of one manager are grouped by department', () => {
    const m = person('Operations Manager', null, 1, 1);
    const a = person('Sales Leader', m, 1, 3);
    const b = person('Operations Leader', m, 1, 1);
    const c = person('Customer Service Leader', m, 1, 3);
    const people = [m, a, b, c, ...staff(2, a, 'Sales Executive', 1, 3), ...staff(2, b, 'Operations Officer', 1, 1), ...staff(2, c, 'Customer Service Officer', 1, 3)];
    const { forest, lay } = layout(people, { byDept: true });
    checkInvariants(forest, lay);
    expect(lay.edges.find((e) => e.to === a.id)?.from).toBe(m.id);
    // department order 1 → 3, input order inside a department
    const order = [a, b, c].sort((x, y) => cx(lay, x.id) - cx(lay, y.id)).map((p) => p.id);
    expect(order).toEqual([b.id, a.id, c.id]);
  });

  it('multi-company: own frame per company, no line across companies, same level bands, cross-company reports framed', () => {
    const md1 = person('Manager Director', null, 1);
    const amd2 = person('Asst. Managing Director', md1, 2); // manager in another company
    const people = [md1, ...staff(4, md1, 'LiveStreaming', 1), amd2, ...staff(2, amd2, 'LiveStreaming', 2), person('Quality Control Officer', null, 3)];
    const { forest, lay } = layout(people, { labels: true });
    checkInvariants(forest, lay);
    expect(lay.groups.map((g) => g.key)).toEqual([1, 2, 3]);
    for (let i = 1; i < lay.groups.length; i++) {
      const prev = lay.groups[i - 1] as { x: number; w: number };
      expect((lay.groups[i]?.x ?? 0)).toBeGreaterThan(prev.x + prev.w);
    }
    const comp = new Map(people.map((p) => [p.id, p.company_id]));
    expect(lay.edges.every((e) => comp.get(e.from) === comp.get(e.to))).toBe(true);
    expect(lay.edges.some((e) => e.to === amd2.id)).toBe(false);
    for (const p of people) expect(inside(rect(lay.nodes.get(p.id) as { x: number; y: number }), box(lay.groups.find((g) => g.key === p.company_id) as never))).toBe(true);
    // AMD of company 2 shares the L2 band with nothing else in between, in a frame naming its real manager
    expect(lay.nodes.get(amd2.id)?.y).toBe(lay.bands[1]?.y);
    expect(lay.externals).toEqual([expect.objectContaining({ key: 2, manager: md1.id, ids: [amd2.id] })]);
    // its own team still hangs below it
    expect(lay.edges.filter((e) => e.from === amd2.id)).toHaveLength(2);
  });

  it('switching company = the same layout as that company on its own (no header)', () => {
    const md = person('Manager Director', null, 7);
    const people = [md, ...staff(5, md, 'Graphic Designer', 7)];
    const alone = layout(people).lay;
    expect([...alone.nodes.keys()].sort()).toEqual(people.map((p) => p.id).sort());
    expect(alone.groups[0]?.label).toBeNull();
  });

  it('balanced: the largest tree in the centre, other units split left / right, the no-line block at the right end', () => {
    const big = person('Asst. Managing Director', null);
    const people: P[] = [big];
    for (let i = 0; i < 4; i++) {
      const m = person('Operations Manager', big);
      people.push(m, ...staff(3, m));
    }
    const small1 = person('Account Manager', null);
    const small2 = person('Sales Leader', null);
    const ext = { ...person('Operations Officer', null), manager_id: 5000 };
    const loose = person('LiveStreaming', null);
    people.push(small1, ...staff(2, small1, 'Accountant'), small2, ...staff(1, small2, 'Sales Executive'), ext, loose);
    const { forest, lay } = layout(people);
    checkInvariants(forest, lay);
    const x = (id: number) => lay.nodes.get(id)?.x ?? 0;
    const lefts = [small1.id, small2.id, ext.id].filter((id) => x(id) < x(big.id));
    const rights = [small1.id, small2.id, ext.id].filter((id) => x(id) > x(big.id));
    expect(lefts.length).toBeGreaterThan(0);
    expect(rights.length).toBeGreaterThan(0);
    expect(x(loose.id)).toBe(Math.max(...[...lay.nodes.values()].map((n) => n.x)));
  });

  it('department filter: the context manager stays a dashed root above the members', () => {
    const m = person('Operations Manager', null, 1, 1);
    const l = person('Operations Leader', m, 1, 2);
    const s = staff(4, l).map((p) => ({ ...p, department_id: 2 }));
    const { forest, lay } = layout([m, l, ...s], { include: (p) => p.department_id === 2 });
    checkInvariants(forest, lay);
    expect(forest.context.has(m.id)).toBe(true);
    expect(lay.edges.find((e) => e.to === l.id)?.context).toBe(true);
    expect(lay.externals).toHaveLength(0);
  });

  it('collapse hides a team and re-layouts without gaps or overlaps', () => {
    const m = person('Operations Manager', null);
    const l = person('Operations Leader', m);
    const people = [m, l, ...staff(8, l), ...staff(2, m)];
    const { forest, lay } = layout(people, { collapsed: [l.id] });
    checkInvariants(forest, lay, [l.id]);
    expect(lay.nodes.size).toBe(people.length - 8);
  });

  it('production-shaped company (45 people, 3 loose) keeps every invariant', () => {
    const amd = person('Asst. Managing Director', null);
    const people: P[] = [amd];
    const teams: Array<[string, string, string, number]> = [
      ['Operations Manager', 'Operations Leader', 'Operations Officer', 6],
      ['Operations Manager', 'Customer Service Leader', 'Customer Service Officer', 8],
      ['Account Manager', 'Sales Leader', 'Accountant', 3],
      ['Human Resources Manager', 'HR Leader (Payroll & Admin)', 'HR Officer (Recruit & Training)', 2],
    ];
    for (const [mt, lt, st, n] of teams) {
      const mg = person(mt, amd);
      const ld = person(lt, mg);
      people.push(mg, ld, ...staff(n, ld, st));
    }
    const gd = person('Leader Graphic Designer', amd);
    people.push(gd, ...staff(6, gd, 'Graphic Designer'));
    const bd = person('Business Development', amd);
    people.push(bd, person('Business Development', amd), ...staff(1, bd, 'Sales Executive'));
    people.push(person('LiveStreaming', null), person('LiveStreaming', null), person('Quality Control Officer', null));
    const { forest, lay } = layout(people);
    checkInvariants(forest, lay);
    expect(lay.nodes.size).toBe(people.length);
    // a team of 8 is three cards wide, not eight
    expect(Math.max(...gridRows(lay, people.find((p) => p.title === 'Customer Service Leader')?.id as number))).toBe(3);
    // collapsed in every possible way: still valid
    for (const c of people.filter((p) => people.some((q) => q.manager_id === p.id))) {
      const { forest: f2, lay: l2 } = layout(people, { collapsed: [c.id] });
      checkInvariants(f2, l2, [c.id]);
    }
  });

  it('large organization: 3 companies, ~900 people, cross-company reports, loops — valid and fast', () => {
    let rnd = 7;
    const rand = (n: number) => {
      rnd = (rnd * 1103515245 + 12345) % 2147483648;
      return rnd % n;
    };
    const people: P[] = [];
    for (const c of [11, 12, 13]) {
      const md = person('Manager Director', null, c, c * 10);
      const amds = [0, 1, 2].map((i) => person('Asst. Managing Director', md, c, c * 10 + i));
      people.push(md, ...amds);
      for (let m = 0; m < 12; m++) {
        const amd = amds[m % 3] as P;
        const mg = person('Operations Manager', amd, c, amd.department_id);
        people.push(mg);
        for (let l = 0; l < 3; l++) {
          const ld = person('Operations Leader', mg, c, amd.department_id);
          people.push(ld, ...staff(1 + rand(10), ld, 'Operations Officer', c, amd.department_id));
        }
      }
      people.push(person('LiveStreaming', null, c, null));
    }
    // a few reports to managers in another company, and a loop
    for (let i = 0; i < 6; i++) (people[50 + i * 70] as P).manager_id = (people[(50 + i * 70 + 300) % people.length] as P).id;
    const a = person('Sales Leader', null, 11);
    const b = person('Sales Leader', a, 11);
    a.manager_id = b.id;
    people.push(a, b);
    const t0 = performance.now();
    const { forest, lay } = layout(people, { labels: true, byDept: true });
    const ms = performance.now() - t0;
    expect(lay.nodes.size).toBe(people.length);
    expect(ms).toBeLessThan(2000);
    checkInvariants(forest, lay);
    const comp = new Map(people.map((p) => [p.id, p.company_id]));
    expect(lay.edges.every((e) => comp.get(e.from) === comp.get(e.to))).toBe(true);
  }, 60_000);
});

describe('department colours', () => {
  it('every colour reads on the light and the dark card (≥ 3:1) and the list has no repeats', () => {
    expect(new Set(DEPT_COLORS).size).toBe(DEPT_COLORS.length);
    expect(DEPT_COLORS.length).toBeGreaterThanOrEqual(16);
    for (const c of [...DEPT_COLORS, NO_DEPT_COLOR]) {
      expect(contrast(c, '#ffffff'), `${c} on light`).toBeGreaterThanOrEqual(3);
      expect(contrast(c, '#111827'), `${c} on dark`).toBeGreaterThanOrEqual(3);
    }
    expect(DEPT_COLORS).not.toContain(NO_DEPT_COLOR);
  });

  it('colours follow the department order of the scope, not the id: same department = same colour, neighbours differ', () => {
    // ids that collided under the old "id % 10" rule
    const m = departmentColors([3, 13, 23, 7]);
    expect(m.get(3)).toBe(DEPT_COLORS[0]);
    expect(m.get(13)).toBe(DEPT_COLORS[1]);
    expect(new Set(m.values()).size).toBe(4);
    expect(departmentColors([3, 13, 23, 7]).get(23)).toBe(m.get(23));
  });
});
