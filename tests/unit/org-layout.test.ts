import { describe, expect, it } from 'vitest';
import { buildOrgForest, mergeForests, type OrgForest } from '../../src/shared/org-tree';
import { POSITION_LEVELS, positionLevel, type OrgLevel } from '../../src/shared/org-levels';
import { CARD_H, CARD_W, GRID_COLS, layoutOrg, type OrgLayout } from '../../src/shared/org-layout';

// Synthetic people only (no production data): id, manager, company, position title.
interface P { id: number; manager_id: number | null; department_id: number | null; company_id: number; title: string }

let seq = 0;
function person(title: string, manager: P | null, company = 1, dept: number | null = 1): P {
  return { id: ++seq, manager_id: manager?.id ?? null, department_id: dept, company_id: company, title };
}

function layout(people: P[], opts: { collapsed?: number[]; companies?: number[]; labels?: boolean; include?: (p: P) => boolean; aspect?: number; maxRowWidth?: number } = {}) {
  const companies = opts.companies ?? [...new Set(people.map((p) => p.company_id))];
  const include = opts.include ?? (() => true);
  const forest = mergeForests(companies.map((c) => buildOrgForest(people.filter((p) => p.company_id === c), include)));
  const byId = new Map(people.map((p) => [p.id, p]));
  const lay = layoutOrg({
    forest,
    levelOf: (id) => positionLevel(byId.get(id)?.title).level,
    groupOf: (id) => byId.get(id)?.company_id ?? 0,
    groups: companies.map((c) => ({ key: c, label: opts.labels ? `Company ${c}` : null })),
    hasManager: (id) => (byId.get(id)?.manager_id ?? null) !== null,
    collapsed: new Set(opts.collapsed ?? []),
    aspect: opts.aspect,
    maxRowWidth: opts.maxRowWidth,
  });
  return { forest, lay };
}

type Rect = { l: number; t: number; r: number; b: number };
const rect = (n: { x: number; y: number }): Rect => ({ l: n.x, t: n.y, r: n.x + CARD_W, b: n.y + CARD_H });
const overlap = (a: Rect, b: Rect) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

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
        const inside = x1 === x2
          ? c.l < x1 && x1 < c.r && seg.t < c.b && seg.b > c.t
          : c.t < y1 && y1 < c.b && seg.l < c.r && seg.r > c.l;
        expect(inside, `edge ${e.from}->${e.to} crosses card ${id}`).toBe(false);
      }
    }
  }

  // Staff / Admin grids: ≤ 3 per row, one manager per grid, last row centred under the block
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
  return lay;
}

const gridRows = (lay: OrgLayout, parent: number) => {
  const rows = new Map<number, number>();
  for (const n of lay.nodes.values()) if (n.grid?.parent === parent) rows.set(n.grid.gridRow, (rows.get(n.grid.gridRow) ?? 0) + 1);
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
};
const staff = (n: number, mgr: P, title = 'Customer Service Officer', company = 1) => Array.from({ length: n }, () => person(title, mgr, company));

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

describe('organization layout (inverted bell)', () => {
  it('1. a small company: MD on top, two staff in one centred row', () => {
    const md = person('Manager Director', null);
    const s = staff(2, md);
    const { forest, lay } = layout([md, ...s]);
    checkInvariants(forest, lay);
    expect(lay.nodes.get(md.id)?.row).toBe(0);
    expect(gridRows(lay, md.id)).toEqual([2]);
    // staff sit in the L5 band even though they report straight to the MD
    expect(lay.nodes.get(s[0]?.id as number)?.row).toBe(4);
    const mdC = (lay.nodes.get(md.id)?.x ?? 0) + CARD_W / 2;
    const rowC = s.reduce((a, p) => a + (lay.nodes.get(p.id)?.x ?? 0) + CARD_W / 2, 0) / s.length;
    expect(Math.abs(mdC - rowC)).toBeLessThan(0.01);
  });

  it('2, 6, 7. several departments, managers and leaders: one band per level, top narrower than the bottom', () => {
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
    for (const lv of [1, 2, 3, 4] as OrgLevel[]) expect(bandY(lv).size).toBe(1);
    expect(lay.bands.map((b) => b.level)).toEqual([1, 2, 3, 4, 5]);
    const span = (lv: OrgLevel) => {
      const xs = ids(lv).map((id) => lay.nodes.get(id)?.x ?? 0);
      return Math.max(...xs) + CARD_W - Math.min(...xs);
    };
    expect(span(1)).toBeLessThanOrEqual(span(3));
    expect(span(3)).toBeLessThanOrEqual(span(4));
    expect(span(4)).toBeLessThanOrEqual(span(5));
  });

  it('3. a leader with 1–3 staff: one row', () => {
    for (const n of [1, 2, 3]) {
      const l = person('Sales Leader', null);
      const { forest, lay } = layout([l, ...staff(n, l)]);
      checkInvariants(forest, lay);
      expect(gridRows(lay, l.id)).toEqual([n]);
    }
  });

  it('4. a leader with 4–6 staff: two rows, 3 + the rest centred', () => {
    for (const [n, rows] of [[4, [3, 1]], [5, [3, 2]], [6, [3, 3]]] as const) {
      const l = person('Customer Service Leader', null);
      const { forest, lay } = layout([l, ...staff(n, l)]);
      checkInvariants(forest, lay);
      expect(gridRows(lay, l.id)).toEqual(rows);
    }
  });

  it('5. a leader with 7–12 staff: 3 + 3 + … downwards, never wider than three cards', () => {
    for (const [n, rows] of [[7, [3, 3, 1]], [8, [3, 3, 2]], [9, [3, 3, 3]], [10, [3, 3, 3, 1]], [12, [3, 3, 3, 3]]] as const) {
      const l = person('Operations Leader', null);
      const s = staff(n, l);
      const { forest, lay } = layout([l, ...s]);
      checkInvariants(forest, lay);
      expect(gridRows(lay, l.id)).toEqual(rows);
      const xs = s.map((p) => lay.nodes.get(p.id)?.x ?? 0);
      expect(Math.max(...xs) + CARD_W - Math.min(...xs)).toBeLessThanOrEqual(3 * CARD_W + 2 * 18 + 0.01);
    }
  });

  it('staff of different managers never share a grid, even when one team is small', () => {
    const m = person('Operations Manager', null);
    const a = person('Operations Leader', m);
    const b = person('Sales Leader', m);
    const sa = staff(2, a);
    const sb = staff(2, b);
    const { forest, lay } = layout([m, a, b, ...sa, ...sb]);
    checkInvariants(forest, lay);
    expect(gridRows(lay, a.id)).toEqual([2]);
    expect(gridRows(lay, b.id)).toEqual([2]);
  });

  it('a manager with both leaders and direct staff: the staff block sits between the branches', () => {
    const m = person('Operations Manager', null);
    const l1 = person('Operations Leader', m);
    const l2 = person('Sales Leader', m);
    const direct = staff(5, m);
    const { forest, lay } = layout([m, l1, ...staff(3, l1), l2, ...staff(2, l2), ...direct]);
    checkInvariants(forest, lay);
    expect(gridRows(lay, m.id)).toEqual([3, 2]);
    const x = (id: number) => lay.nodes.get(id)?.x ?? 0;
    expect(x(l1.id)).toBeLessThan(x(direct[0]?.id as number));
    expect(x(direct[2]?.id as number)).toBeLessThan(x(l2.id));
  });

  it('Business Development (L5) with reports stays L5; its reports hang below it by manager_id', () => {
    const l = person('Sales Leader', null);
    const bd = person('Business Development', l);
    const peer = person('Business Development', l);
    const reports = staff(4, bd, 'Sales Executive');
    const { forest, lay } = layout([l, bd, peer, ...reports]);
    checkInvariants(forest, lay);
    expect(lay.nodes.get(bd.id)?.row).toBe(4);
    expect(lay.nodes.get(bd.id)?.grid).toBeNull(); // has reports: a branch, not a grid card
    expect(lay.nodes.get(peer.id)?.grid?.parent).toBe(l.id);
    expect(gridRows(lay, bd.id)).toEqual([3, 1]);
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

  it('8. people without a manager and without reports go to the "no reporting line" block; nobody is lost', () => {
    const amd = person('Asst. Managing Director', null); // top of the company: has reports, stays the tree root
    const m = person('Operations Manager', amd);
    const loose = [person('LiveStreaming', null), person('LiveStreaming', null), person('Quality Control Officer', null)];
    const { forest, lay } = layout([amd, m, ...staff(3, m), ...loose]);
    checkInvariants(forest, lay);
    expect(lay.orphans).toHaveLength(1);
    expect(lay.orphans[0]?.ids).toEqual(loose.map((p) => p.id));
    for (const p of loose) expect(lay.nodes.get(p.id)?.orphan).toBe(true);
    expect(lay.nodes.get(amd.id)?.orphan).toBe(false);
    const treeBottom = Math.max(...[amd, m].map((p) => (lay.nodes.get(p.id)?.y ?? 0) + CARD_H));
    expect(lay.orphans[0]?.y).toBeGreaterThan(treeBottom);
  });

  it('a person whose manager is outside the chart is not counted as "no reporting line"', () => {
    const p = { ...person('Operations Officer', null), manager_id: 9999 };
    const { forest, lay } = layout([p]);
    checkInvariants(forest, lay);
    expect(lay.orphans).toHaveLength(0);
  });

  it('9. a reports-to loop: everyone shown once, finite, the cut point is a tree root', () => {
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
  });

  it('10. several companies: separate groups side by side, no line across companies', () => {
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
    expect(lay.edges.some((e) => e.to === amd2.id)).toBe(false);
    const inGroup = (id: number, k: number) => {
      const g = lay.groups.find((x) => x.key === k) as { x: number; w: number };
      const n = lay.nodes.get(id) as { x: number };
      return n.x >= g.x && n.x + CARD_W <= g.x + g.w;
    };
    for (const p of people) expect(inGroup(p.id, p.company_id)).toBe(true);
    // the same levels share a band across companies
    expect(lay.nodes.get(amd2.id)?.row).toBe(1);
  });

  it('10. switching company = the same layout as that company on its own', () => {
    const md = person('Manager Director', null, 7);
    const people = [md, ...staff(5, md, 'Graphic Designer', 7)];
    const alone = layout(people).lay;
    expect([...alone.nodes.keys()].sort()).toEqual(people.map((p) => p.id).sort());
    expect(alone.groups[0]?.label).toBeNull();
  });

  it('department filter: context manager stays a dashed root above the members', () => {
    const m = person('Operations Manager', null, 1, 1);
    const l = person('Operations Leader', m, 1, 2);
    const s = staff(4, l).map((p) => ({ ...p, department_id: 2 }));
    const { forest, lay } = layout([m, l, ...s], { include: (p) => p.department_id === 2 });
    checkInvariants(forest, lay);
    expect(forest.context.has(m.id)).toBe(true);
    expect(lay.edges.find((e) => e.to === l.id)?.context).toBe(true);
  });

  it('collapse hides a team and re-layouts without gaps or overlaps', () => {
    const m = person('Operations Manager', null);
    const l = person('Operations Leader', m);
    const people = [m, l, ...staff(8, l), ...staff(2, m)];
    const { forest, lay } = layout(people, { collapsed: [l.id] });
    checkInvariants(forest, lay, [l.id]);
    expect(lay.nodes.size).toBe(people.length - 8);
  });

  it('large production-shaped company (45 people, 3 loose) keeps every invariant', () => {
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
  });
});

describe('balanced multi-row layout (stacked teams)', () => {
  // a company shaped like production: many teams under one AMD
  function wideCompany(company = 1) {
    const amd = person('Asst. Managing Director', null, company);
    const people: P[] = [amd];
    const teams: Array<[string, string, string, number]> = [
      ['Operations Manager', 'Operations Leader', 'Operations Officer', 6],
      ['Operations Manager', 'Customer Service Leader', 'Customer Service Officer', 8],
      ['Account Manager', 'Sales Leader', 'Accountant', 3],
      ['Human Resources Manager', 'HR Leader (Payroll & Admin)', 'HR Officer (Recruit & Training)', 2],
    ];
    for (const [mt, lt, st, n] of teams) {
      const mg = person(mt, amd, company);
      const ld = person(lt, mg, company);
      people.push(mg, ld, ...staff(n, ld, st, company));
    }
    const gd = person('Leader Graphic Designer', amd, company);
    people.push(gd, ...staff(6, gd, 'Graphic Designer', company));
    const bd = person('Business Development', amd, company);
    people.push(bd, person('Business Development', amd, company), ...staff(1, bd, 'Sales Executive', company));
    people.push(person('LiveStreaming', null, company), person('Quality Control Officer', null, company));
    return { amd, people };
  }

  it('stacks the teams of a wide manager in tiers of two; every invariant still holds', () => {
    const { amd, people } = wideCompany();
    const natural = layout(people).lay;
    const { forest, lay } = layout(people, { maxRowWidth: 1600 });
    checkInvariants(forest, lay);
    expect(lay.stacked).toContain(amd.id);
    expect(lay.bounds.w).toBeLessThan(natural.bounds.w * 0.6);
    expect(lay.nodes.size).toBe(people.length);
  });

  it('inside a tier the levels line up, and every tier sits below the manager', () => {
    const { amd, people } = wideCompany();
    const { lay } = layout(people, { maxRowWidth: 1600 });
    const managers = people.filter((p) => positionLevel(p.title).level === 3 && p.manager_id === amd.id);
    const amdY = lay.nodes.get(amd.id)?.y ?? 0;
    for (const m of managers) expect(lay.nodes.get(m.id)?.y ?? 0).toBeGreaterThan(amdY + CARD_H);
    // first tier: the two managers share a row
    const ys = managers.map((m) => lay.nodes.get(m.id)?.y);
    expect(ys[0]).toBe(ys[1]);
    // every level band label still names one level per row
    for (const b of lay.bands) {
      const onRow = [...lay.nodes.entries()].filter(([, n]) => n.y === b.y && !n.orphan && !(n.grid && n.grid.gridRow > 0));
      expect(onRow.every(([id]) => positionLevel(people.find((p) => p.id === id)?.title).level === b.level)).toBe(true);
    }
  });

  it('aspect-driven: a screen-shaped stage gets a better whole-chart fit than one wide row', () => {
    const { people } = wideCompany();
    const natural = layout(people).lay;
    const fit = (l: OrgLayout, w: number, h: number) => Math.min(w / l.bounds.w, h / l.bounds.h);
    for (const [w, h] of [[760, 600], [1250, 760], [1900, 1100]] as const) {
      const { forest, lay } = layout(people, { aspect: w / h });
      checkInvariants(forest, lay);
      expect(fit(lay, w, h)).toBeGreaterThanOrEqual(fit(natural, w, h));
    }
    const { lay } = layout(people, { aspect: 760 / 600 });
    expect(fit(lay, 760, 600)).toBeGreaterThan(fit(natural, 760, 600) * 1.5);
  });

  it('narrow stage: teams go into one column on a side trunk; still no overlap or crossing', () => {
    const { amd, people } = wideCompany();
    const { forest, lay } = layout(people, { maxRowWidth: 760 });
    checkInvariants(forest, lay);
    expect(lay.stacked).toContain(amd.id);
    // nothing is wider than the widest team (3 staff cards + spines) plus the trunk gutters
    expect(lay.bounds.w).toBeLessThan(1500);
    expect(lay.nodes.size).toBe(people.length);
  });

  it('a chart that already fits is left side by side', () => {
    const l = person('Sales Leader', null);
    const { lay } = layout([l, ...staff(3, l)], { aspect: 1.6 });
    expect(lay.stacked).toHaveLength(0);
  });

  it('every earlier scenario keeps its invariants under stacking', () => {
    for (const w of [700, 1000, 1400]) {
      const md = person('Manager Director', null);
      const amd = person('Asst. Managing Director', md);
      const people: P[] = [md, amd];
      for (let t = 0; t < 5; t++) {
        const m = person('Operations Manager', amd);
        const l1 = person('Operations Leader', m);
        const l2 = person('Sales Leader', m);
        const bd = person('Business Development', l2);
        people.push(m, l1, ...staff(3 + t * 2, l1), l2, ...staff(t + 1, l2), bd, ...staff(t, bd, 'Sales Executive'), ...staff(t % 3, m));
      }
      const a = person('Operations Leader', null);
      const b = person('Operations Leader', a);
      a.manager_id = b.id;
      people.push(a, b, person('LiveStreaming', null));
      const { forest, lay } = layout(people, { maxRowWidth: w });
      checkInvariants(forest, lay);
      const { forest: f2, lay: l2c } = layout(people, { maxRowWidth: w, collapsed: [people[2]?.id as number] });
      checkInvariants(f2, l2c, [people[2]?.id as number]);
    }
  });

  it('several companies wrap into rows of groups; frames never overlap; no line across companies', () => {
    const a = wideCompany(1);
    const b = wideCompany(2);
    const c = wideCompany(3);
    const people = [...a.people, ...b.people, ...c.people];
    const { forest, lay } = layout(people, { labels: true, aspect: 1.3 });
    checkInvariants(forest, lay);
    expect(lay.groups).toHaveLength(3);
    for (let i = 0; i < lay.groups.length; i++) {
      for (let j = i + 1; j < lay.groups.length; j++) {
        const g = lay.groups[i] as { x: number; y: number; w: number; h: number };
        const k = lay.groups[j] as { x: number; y: number; w: number; h: number };
        expect(g.x < k.x + k.w && k.x < g.x + g.w && g.y < k.y + k.h && k.y < g.y + g.h).toBe(false);
      }
    }
    const comp = new Map(people.map((p) => [p.id, p.company_id]));
    expect(lay.edges.every((e) => comp.get(e.from) === comp.get(e.to))).toBe(true);
    for (const p of people) {
      const g = lay.groups.find((x) => x.key === p.company_id) as { x: number; y: number; w: number; h: number };
      const n = lay.nodes.get(p.id) as { x: number; y: number };
      expect(n.x >= g.x && n.x + CARD_W <= g.x + g.w && n.y >= g.y && n.y + CARD_H <= g.y + g.h).toBe(true);
    }
  });
});
