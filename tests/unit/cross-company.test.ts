// Cross Company Manager Assignment: pure rules (validation, states, loops), the reference-card layout and the routing of
// the dashed lines. Synthetic people only (no production data).
import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_TYPES, assignmentLoop, assignmentState, inEffect, periodsOverlap, refFrameKey, refKey, validateAssignment,
  type AssignmentDraft, type ExistingAssignment, type ValidationContext,
} from '../../src/shared/cross-company';
import { buildOrgForest, mergeForests } from '../../src/shared/org-tree';
import { positionLevel, type OrgLevel } from '../../src/shared/org-levels';
import { CARD_H, CARD_W, layoutOrg, type OrgLayout } from '../../src/shared/org-layout';
import { routeLinks, segmentHitsRect, type Rect } from '../../src/shared/org-route';

// ---- fixtures: companies A (1) and B (2); departments 10 (A), 20 / 21 (B), 22 (B, inactive) ----
interface Emp { id: number; company_id: number; department_id: number | null; manager_id: number | null; active: boolean; title: string }
const E: Emp[] = [
  { id: 1, company_id: 1, department_id: 10, manager_id: null, active: true, title: 'Manager Director' },
  { id: 2, company_id: 1, department_id: 10, manager_id: 1, active: true, title: 'Asst. Managing Director' },
  { id: 3, company_id: 2, department_id: 20, manager_id: null, active: true, title: 'Manager Director' },
  { id: 4, company_id: 2, department_id: 20, manager_id: 3, active: true, title: 'Operations Leader' },
  { id: 5, company_id: 2, department_id: 21, manager_id: 3, active: true, title: 'Operations Officer' },
  { id: 6, company_id: 2, department_id: 21, manager_id: 3, active: false, title: 'Operations Officer' },
];
const DEPS = [{ id: 10, company_id: 1, active: true }, { id: 20, company_id: 2, active: true }, { id: 21, company_id: 2, active: true }, { id: 22, company_id: 2, active: false }];
const draft = (over: Partial<AssignmentDraft> = {}): AssignmentDraft => ({
  manager_employee_id: 2, target_company_id: 2, target_department_id: 20, team_name: 'Content', employee_id: null, relationship_type: 'team_lead', responsibility: null,
  effective_from: '2026-11-01', effective_to: null, ...over,
});
const existing: ExistingAssignment[] = [];
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  person: (id) => {
    const p = E.find((x) => x.id === id);
    return p ? { id: p.id, company_id: p.company_id, active: p.active } : undefined;
  },
  department: (id) => DEPS.find((d) => d.id === id),
  companyExists: (id) => id === 1 || id === 2,
  existing,
  loop: (d) => assignmentLoop(d, E.filter((p) => p.active), []),
  ...over,
});

describe('validation', () => {
  it('a valid cross-company team assignment (whole team) passes', () => {
    expect(validateAssignment(draft(), ctx())).toEqual([]);
  });
  it('a valid assignment for one named employee of the target company passes', () => {
    expect(validateAssignment(draft({ employee_id: 4, relationship_type: 'functional_manager' }), ctx())).toEqual([]);
  });
  it('invalid employee / manager: unknown, left the company, same person', () => {
    expect(validateAssignment(draft({ manager_employee_id: 99 }), ctx()).join()).toContain('ไม่พบผู้รับผิดชอบ');
    expect(validateAssignment(draft({ employee_id: 99 }), ctx()).join()).toContain('ไม่พบพนักงาน');
    expect(validateAssignment(draft({ employee_id: 6 }), ctx()).join()).toContain('พ้นสภาพ');
    expect(validateAssignment(draft({ employee_id: 2 }), ctx()).join()).toContain('คนละคน');
  });
  it('companies and target department are checked', () => {
    // same company as the target = not cross-company (that is the primary reporting line)
    expect(validateAssignment(draft({ manager_employee_id: 4 }), ctx()).join()).toContain('บริษัทเดียวกับบริษัทปลายทาง');
    expect(validateAssignment(draft({ target_department_id: 10 }), ctx()).join()).toContain('ไม่ได้อยู่ในบริษัทปลายทาง');
    expect(validateAssignment(draft({ target_department_id: 22 }), ctx()).join()).toContain('ปิดใช้งาน');
    expect(validateAssignment(draft({ target_department_id: 99 }), ctx()).join()).toContain('ไม่พบหน่วยงาน');
    expect(validateAssignment(draft({ target_company_id: 9 }), ctx()).join()).toContain('ไม่พบบริษัทปลายทาง');
    // the named employee must belong to the target company
    expect(validateAssignment(draft({ employee_id: 1, manager_employee_id: 4, target_company_id: 1, target_department_id: 10 }), ctx())).toEqual([]);
    expect(validateAssignment(draft({ employee_id: 1 }), ctx()).join()).toContain('ต้องสังกัดบริษัทปลายทาง');
  });
  it('effective dates: valid ISO dates, end not before start', () => {
    expect(validateAssignment(draft({ effective_to: '2026-10-31' }), ctx()).join()).toContain('ไม่ก่อนวันที่เริ่มมีผล');
    expect(validateAssignment(draft({ effective_to: '2026-11-01' }), ctx())).toEqual([]);
    expect(validateAssignment(draft({ effective_from: '2026-02-30' }), ctx()).join()).toContain('วันที่เริ่มมีผลไม่ถูกต้อง');
    expect(validateAssignment(draft({ relationship_type: 'boss' }), ctx()).join()).toContain('ประเภท');
  });
  it('duplicate: same person, team, employee and type over overlapping dates; a cancelled or non-overlapping one is no duplicate', () => {
    const row = (over: Partial<ExistingAssignment>): ExistingAssignment => ({ id: 7, manager_employee_id: 2, target_department_id: 20, team_name: 'content ', employee_id: null, relationship_type: 'team_lead', status: 'active', effective_from: '2026-01-01', effective_to: null, ...over });
    expect(validateAssignment(draft(), ctx({ existing: [row({})] })).join()).toContain('#7');
    expect(validateAssignment(draft(), ctx({ existing: [row({ status: 'cancelled' })] }))).toEqual([]);
    expect(validateAssignment(draft(), ctx({ existing: [row({ effective_to: '2026-10-31' })] }))).toEqual([]);
    // editing the row itself is no duplicate
    expect(validateAssignment(draft(), ctx({ existing: [row({})], exceptId: 7 }))).toEqual([]);
    // multiple departments / multiple companies for one person are allowed
    expect(validateAssignment(draft({ target_department_id: 21 }), ctx({ existing: [row({})] }))).toEqual([]);
    expect(validateAssignment(draft({ relationship_type: 'project_lead' }), ctx({ existing: [row({})] }))).toEqual([]);
  });
  it('a relationship loop is refused', () => {
    // 4 (B) already responsible for department 10 (A) where 2 works; 2 must not become responsible for 4
    const active = [{ manager_employee_id: 4, employee_id: null, target_department_id: 10 }];
    const loop = (d: AssignmentDraft) => assignmentLoop(d, E.filter((p) => p.active), active);
    expect(validateAssignment(draft({ employee_id: 4, relationship_type: 'functional_manager' }), ctx({ loop })).join()).toContain('Relationship Loop');
    // through the primary line: 4 reports to 3; 3 responsible for dept 10 → 2 responsible for dept 20 (holds 4) loops
    expect(assignmentLoop({ manager_employee_id: 2, employee_id: null, target_department_id: 20 }, E, [{ manager_employee_id: 3, employee_id: null, target_department_id: 10 }])).toBe(true);
    expect(assignmentLoop({ manager_employee_id: 2, employee_id: null, target_department_id: 20 }, E, [])).toBe(false);
  });
  it('the loop walk terminates on loops already in the data', () => {
    const people = [{ id: 1, manager_id: 2, department_id: 1 }, { id: 2, manager_id: 1, department_id: 1 }, { id: 3, manager_id: null, department_id: 2 }];
    expect(assignmentLoop({ manager_employee_id: 1, employee_id: 3, target_department_id: 2 }, people, [])).toBe(false);
  });
});

describe('states and dates', () => {
  const a = (over: Partial<{ status: 'active' | 'inactive' | 'cancelled'; effective_from: string; effective_to: string | null }>) => ({ status: 'active' as const, effective_from: '2026-11-01', effective_to: '2026-11-30', ...over });
  it('active / scheduled / expired / inactive / cancelled', () => {
    expect(assignmentState(a({}), '2026-11-11')).toBe('active');
    expect(assignmentState(a({}), '2026-11-30')).toBe('active');
    expect(assignmentState(a({}), '2026-10-31')).toBe('scheduled');
    expect(assignmentState(a({}), '2026-12-01')).toBe('expired');
    expect(assignmentState(a({ status: 'inactive' }), '2026-11-11')).toBe('inactive');
    expect(assignmentState(a({ status: 'cancelled' }), '2026-11-11')).toBe('cancelled');
    expect(inEffect(a({ effective_to: null }), '2099-01-01')).toBe(true);
    // an expired assignment is never in effect
    expect(inEffect(a({}), '2026-12-01')).toBe(false);
  });
  it('period overlap with open ends', () => {
    expect(periodsOverlap({ effective_from: '2026-01-01', effective_to: null }, { effective_from: '2030-01-01', effective_to: null })).toBe(true);
    expect(periodsOverlap({ effective_from: '2026-01-01', effective_to: '2026-01-31' }, { effective_from: '2026-02-01', effective_to: null })).toBe(false);
  });
  it('the four relationship types', () => {
    expect([...ASSIGNMENT_TYPES]).toEqual(['team_lead', 'functional_manager', 'project_lead', 'operational_supervisor']);
  });
});

// ---- chart: reference cards in the layout, dashed-line routing ----
interface P { id: number; manager_id: number | null; department_id: number | null; company_id: number; title: string }
let seq = 1000;
const p = (title: string, mgr: P | null, company: number, dept: number): P => ({ id: ++seq, manager_id: mgr?.id ?? null, department_id: dept, company_id: company, title });
function chart(people: P[], refs: Array<{ key: string; group: number; frame: string; level: OrgLevel }> = []) {
  const companies = [...new Set(people.map((x) => x.company_id))];
  const forest = mergeForests(companies.map((c) => buildOrgForest(people.filter((x) => x.company_id === c), () => true)));
  const byId = new Map(people.map((x) => [x.id, x]));
  const lay = layoutOrg({
    forest, levelOf: (id) => positionLevel(byId.get(id)?.title).level, groupOf: (id) => byId.get(id)?.company_id ?? 0,
    groups: companies.map((c) => ({ key: c, label: `Co ${c}` })), managerOf: (id) => byId.get(id)?.manager_id ?? null, collapsed: new Set(), refs,
  });
  return { forest, lay };
}
const card = (n: { x: number; y: number }): Rect => ({ x: n.x, y: n.y, w: CARD_W, h: CARD_H });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function allCards(lay: OrgLayout): Array<[string, Rect]> {
  return [...[...lay.nodes.entries()].map(([id, n]) => [`n${id}`, card(n)] as [string, Rect]), ...[...lay.refs.entries()].map(([k, r]) => [`r${k}`, card(r)] as [string, Rect])];
}

// company A: MD → AMD → 2 managers → staff; company B: MD → manager → leaders → staff
const A1 = p('Manager Director', null, 1, 10);
const A2 = p('Asst. Managing Director', A1, 1, 10);
const A3 = p('Operations Manager', A2, 1, 11);
const A4 = p('Human Resources Manager', A2, 1, 12);
const AS = [...Array.from({ length: 5 }, () => p('Operations Officer', A3, 1, 11)), ...Array.from({ length: 2 }, () => p('HR Officer (Recruit & Training)', A4, 1, 12))];
const B1 = p('Manager Director', null, 2, 20);
const B2 = p('Operations Manager', B1, 2, 20);
const B3 = p('Operations Leader', B2, 2, 21);
const B4 = p('Customer Service Leader', B2, 2, 22);
const BS = [...Array.from({ length: 4 }, () => p('Operations Officer', B3, 2, 21)), ...Array.from({ length: 3 }, () => p('Customer Service Officer', B4, 2, 22))];
const PEOPLE = [A1, A2, A3, A4, ...AS, B1, B2, B3, B4, ...BS];
// A2 (AMD of A) leads team "Content" of department 21 (B) and is functional manager of one officer of B;
// A3 (manager of A) leads team "Live" of department 22 (B)
const LINKS = [
  { id: 1, manager_id: A2.id, employee_id: null, target_company_id: 2, target_department_id: 21, team_name: 'Content' },
  { id: 2, manager_id: A2.id, employee_id: (BS[0] as P).id, target_company_id: 2, target_department_id: 21, team_name: 'Content' },
  { id: 3, manager_id: A3.id, employee_id: null, target_company_id: 2, target_department_id: 22, team_name: 'Live' },
];
const levelOf = (id: number) => positionLevel(PEOPLE.find((x) => x.id === id)?.title).level;
const REFS = [...new Map(LINKS.map((l) => [refKey(l), { key: refKey(l), group: l.target_company_id, frame: refFrameKey(l), level: levelOf(l.manager_id) }])).values()];

describe('reference cards in the layout', () => {
  const base = chart(PEOPLE);
  const withRefs = chart(PEOPLE, REFS);
  it('one reference card per person and target team; one frame per target team; in the target company', () => {
    expect(withRefs.lay.refs.size).toBe(2);
    expect(withRefs.lay.refFrames.map((f) => f.frame).sort()).toEqual(['21|content', '22|live']);
    for (const f of withRefs.lay.refFrames) expect(f.key).toBe(2);
    const groupB = withRefs.lay.groups.find((g) => g.key === 2) as { x: number; w: number };
    for (const r of withRefs.lay.refs.values()) expect(r.x >= groupB.x && r.x + CARD_W <= groupB.x + groupB.w).toBe(true);
  });
  it('no duplicate employee identity and no headcount change: the nodes are exactly the same people', () => {
    expect([...withRefs.lay.nodes.keys()].sort()).toEqual([...base.lay.nodes.keys()].sort());
    expect(withRefs.lay.nodes.size).toBe(PEOPLE.length);
    for (const k of withRefs.lay.refs.keys()) expect(withRefs.lay.nodes.has(Number(k))).toBe(false);
  });
  it('levels L1–L5 unchanged: same bands, every card on the same band row, the reference on its person’s band', () => {
    expect(withRefs.lay.bands).toEqual(base.lay.bands);
    for (const [id, n] of base.lay.nodes) {
      expect(withRefs.lay.nodes.get(id)?.y).toBe(n.y);
      expect(withRefs.lay.nodes.get(id)?.row).toBe(n.row);
    }
    const band = (lv: number) => withRefs.lay.bands.find((b) => b.level === lv)?.y;
    expect(withRefs.lay.refs.get(refKey(LINKS[0] as (typeof LINKS)[number]))?.y).toBe(band(2)); // AMD → L2
    expect(withRefs.lay.refs.get(refKey(LINKS[2] as (typeof LINKS)[number]))?.y).toBe(band(3)); // Manager → L3
  });
  it('primary reporting lines unchanged (same edges, from the same managers)', () => {
    const sig = (lay: OrgLayout) => lay.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(sig(withRefs.lay)).toEqual(sig(base.lay));
  });
  it('no card overlaps any other card or reference card; frames hold their references', () => {
    const cards = allCards(withRefs.lay);
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlaps((cards[i] as [string, Rect])[1], (cards[j] as [string, Rect])[1]), `${cards[i]?.[0]} / ${cards[j]?.[0]}`).toBe(false);
    for (const f of withRefs.lay.refFrames) for (const k of f.refs) {
      const r = withRefs.lay.refs.get(k) as { x: number; y: number };
      expect(r.x >= f.x && r.x + CARD_W <= f.x + f.w && r.y >= f.y && r.y + CARD_H <= f.y + f.h).toBe(true);
    }
  });
  it('several people of different levels in one frame stay on their bands without overlapping; more than 3 wrap', () => {
    const many = [1, 2, 3, 4].map((i) => ({ key: `m${i}`, group: 2, frame: 'x', level: 3 as OrgLevel }));
    const lay = chart(PEOPLE, [...many, { key: 'top', group: 2, frame: 'x', level: 2 }]).lay;
    expect(lay.refFrames).toHaveLength(1);
    const ys = many.map((m) => lay.refs.get(m.key)?.y as number);
    expect(new Set(ys.slice(0, 3)).size).toBe(1);
    expect(ys[3]).toBeGreaterThan(ys[0] as number);
    const cards = allCards(lay);
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlaps((cards[i] as [string, Rect])[1], (cards[j] as [string, Rect])[1])).toBe(false);
  });
  it('a reference for a company that is not on the chart is not placed', () => {
    const lay = chart(PEOPLE, [{ key: 'x', group: 9, frame: 'f', level: 3 }]).lay;
    expect(lay.refs.size).toBe(0);
  });
});

describe('dashed-line routing', () => {
  const { lay } = chart(PEOPLE, REFS);
  const obstacles = allCards(lay).map(([, r]) => r);
  const pairs = [
    { from: card(lay.refs.get(refKey(LINKS[0] as (typeof LINKS)[number])) as { x: number; y: number }), to: card(lay.nodes.get(A2.id) as { x: number; y: number }), toKey: `n${A2.id}`, fromKey: `r${refKey(LINKS[0] as (typeof LINKS)[number])}` },
    { from: card(lay.refs.get(refKey(LINKS[1] as (typeof LINKS)[number])) as { x: number; y: number }), to: card(lay.nodes.get((BS[0] as P).id) as { x: number; y: number }), toKey: `n${(BS[0] as P).id}`, fromKey: `r${refKey(LINKS[1] as (typeof LINKS)[number])}` },
    { from: card(lay.refs.get(refKey(LINKS[2] as (typeof LINKS)[number])) as { x: number; y: number }), to: card(lay.nodes.get(A3.id) as { x: number; y: number }), toKey: `n${A3.id}`, fromKey: `r${refKey(LINKS[2] as (typeof LINKS)[number])}` },
  ];
  const routes = routeLinks(obstacles, pairs);
  it('every link is routed, orthogonal, from the reference card edge to the right person’s card edge', () => {
    routes.forEach((pts, i) => {
      expect(pts, `route ${i}`).not.toBeNull();
      const path = pts as Array<[number, number]>;
      const pr = pairs[i] as (typeof pairs)[number];
      const onEdge = (pt: [number, number], r: Rect) => (pt[0] === r.x || pt[0] === r.x + r.w || pt[1] === r.y || pt[1] === r.y + r.h) && pt[0] >= r.x && pt[0] <= r.x + r.w && pt[1] >= r.y && pt[1] <= r.y + r.h;
      expect(onEdge(path[0] as [number, number], pr.from)).toBe(true);
      expect(onEdge(path[path.length - 1] as [number, number], pr.to)).toBe(true);
      for (let k = 1; k < path.length; k++) {
        const [a, b] = [path[k - 1] as [number, number], path[k] as [number, number]];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      }
    });
  });
  it('no dashed line crosses any card (its own two cards are only touched at the edge)', () => {
    const cards = allCards(lay);
    routes.forEach((pts) => {
      const path = pts as Array<[number, number]>;
      for (let k = 1; k < path.length; k++) for (const [key, r] of cards) expect(segmentHitsRect(path[k - 1] as [number, number], path[k] as [number, number], r), `segment ${k} crosses ${key}`).toBe(false);
    });
  });
  it('lines of one person do not run on top of each other where they need not', () => {
    const a = routes[0] as Array<[number, number]>;
    const b = routes[1] as Array<[number, number]>;
    const cells = (path: Array<[number, number]>) => {
      const s = new Set<string>();
      for (let k = 1; k < path.length; k++) {
        const [p0, p1] = [path[k - 1] as [number, number], path[k] as [number, number]];
        const n = Math.max(Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])) / 6;
        for (let t = 0; t <= n; t++) s.add(`${Math.round(p0[0] + ((p1[0] - p0[0]) * t) / n)},${Math.round(p0[1] + ((p1[1] - p0[1]) * t) / n)}`);
      }
      return s;
    };
    const ca = cells(a);
    const shared = [...cells(b)].filter((x) => ca.has(x)).length;
    expect(shared / Math.min(ca.size, cells(b).size)).toBeLessThan(0.5);
  });
  it('a dashed line is not drawn along a solid reporting line (crossing one is fine)', () => {
    const solid = lay.edges.map((e) => e.points as Array<[number, number]>);
    const soft = routeLinks(obstacles, pairs, solid);
    const along = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
      // overlap length of two collinear axis-aligned segments
      if (a[1] === b[1] && c[1] === d[1] && Math.abs(a[1] - c[1]) <= 6) return Math.max(0, Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) - Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])));
      if (a[0] === b[0] && c[0] === d[0] && Math.abs(a[0] - c[0]) <= 6) return Math.max(0, Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) - Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])));
      return 0;
    };
    for (const pts of soft) {
      const path = pts as Array<[number, number]>;
      let total = 0;
      for (let k = 1; k < path.length; k++) for (const line of solid) for (let j = 1; j < line.length; j++) total += along(path[k - 1] as [number, number], path[k] as [number, number], line[j - 1] as [number, number], line[j] as [number, number]);
      expect(total).toBeLessThan(30);
    }
  });
  it('a route is found in a large chart (performance)', () => {
    const big: P[] = [];
    for (let c = 1; c <= 4; c++) {
      const md = p('Manager Director', null, c, c * 100);
      big.push(md);
      for (let m = 0; m < 6; m++) {
        const mg = p('Operations Manager', md, c, c * 100 + m);
        big.push(mg);
        for (let s = 0; s < 9; s++) big.push(p('Operations Officer', mg, c, c * 100 + m));
      }
    }
    const first = big[0] as P;
    const last = big[big.length - 1] as P;
    const refs = [{ key: 'r', group: 4, frame: 'f', level: 1 as OrgLevel }];
    const L = chart(big, refs).lay;
    const t0 = Date.now();
    const [route] = routeLinks(allCards(L).map(([, r]) => r), [{ from: card(L.refs.get('r') as { x: number; y: number }), to: card(L.nodes.get(first.id) as { x: number; y: number }) }, { from: card(L.refs.get('r') as { x: number; y: number }), to: card(L.nodes.get(last.id) as { x: number; y: number }) }]);
    expect(route).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
