import { describe, expect, it } from 'vitest';
import { buildOrgForest, forestAncestors, forestDescendants, type OrgForest, type OrgPerson } from '../../src/shared/org-tree';

// shaped like seeds/demo.sql: E001 (EXE) heads HR, IT and production; production reports to its own supervisor
const P = (id: number, manager_id: number | null, department_id: number | null): OrgPerson => ({ id, manager_id, department_id });
const demo = [P(1, null, 1), P(2, 1, 2), P(3, 2, 2), P(4, 1, 3), P(5, 1, 5), P(6, 5, 5), P(7, 5, 5)];
const all = () => true;
const dept = (d: number) => (p: OrgPerson) => p.department_id === d;

/** every node reachable from the roots, counted with repetitions */
function walk(f: OrgForest): number[] {
  const out: number[] = [];
  const stack = [...f.roots];
  while (stack.length) {
    const id = stack.pop() as number;
    out.push(id);
    stack.push(...(f.nodes.get(id)?.children ?? []));
  }
  return out;
}

describe('organization forest', () => {
  it('builds the full reporting tree without context nodes', () => {
    const f = buildOrgForest(demo, all);
    expect(f.roots).toEqual([1]);
    expect(f.nodes.get(1)?.children).toEqual([2, 4, 5]);
    expect(f.nodes.get(5)?.children).toEqual([6, 7]);
    expect(f.context.size).toBe(0);
    expect(walk(f).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('department filter keeps the reporting context: an out-of-department manager is a marked context node', () => {
    const f = buildOrgForest(demo, dept(2)); // HR: 2 reports to 1 (EXE), 3 reports to 2
    expect([...f.members]).toEqual([2, 3]);
    expect([...f.context]).toEqual([1]);
    expect(f.roots).toEqual([1]);
    expect(f.nodes.get(1)).toMatchObject({ context: true, children: [2] });
    expect(f.nodes.get(2)).toMatchObject({ context: false, parent: 1, children: [3] });
    // the context manager's other reports (4, 5 — other departments) are not pulled in
    expect(walk(f).sort()).toEqual([1, 2, 3]);
  });

  it('context nodes are never counted as members', () => {
    for (const d of [1, 2, 3, 5]) {
      const f = buildOrgForest(demo, dept(d));
      expect(f.members.size).toBe(demo.filter((p) => p.department_id === d).length);
      for (const c of f.context) expect(f.members.has(c)).toBe(false);
    }
  });

  it('a filter with no members yields an empty forest', () => {
    const f = buildOrgForest(demo, dept(4));
    expect(f.roots).toEqual([]);
    expect(f.nodes.size).toBe(0);
  });

  it('a reports-to cycle never hides people, never loops and is flagged', () => {
    const loop = [P(1, 3, 1), P(2, 1, 1), P(3, 2, 1), P(4, 2, 1)]; // 1 → 3 → 2 → 1, 4 hangs below 2
    const f = buildOrgForest(loop, all);
    expect(f.roots).toEqual([1]);
    expect(f.nodes.get(1)?.cycle).toBe(true);
    const seen = walk(f);
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  it('self-reference and an unknown manager become roots, not loops', () => {
    const f = buildOrgForest([P(1, 1, 1), P(2, 99, 1), P(3, 2, 1)], all);
    expect(f.roots).toEqual([1, 2]);
    expect(f.nodes.get(1)?.cycle).toBe(false);
    expect(f.nodes.get(3)?.parent).toBe(2);
  });

  it('two separate loops are each cut once; everyone appears exactly once', () => {
    const people = [P(1, 2, 1), P(2, 1, 1), P(3, 4, 2), P(4, 3, 2), P(5, null, 2)];
    const f = buildOrgForest(people, all);
    const seen = walk(f);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(5);
    expect([...f.nodes.values()].filter((n) => n.cycle).map((n) => n.id)).toEqual([1, 3]);
  });

  it('a loop that runs through a context manager stays finite', () => {
    // 2 (dept 2) reports to 1 (dept 1) who reports to 2
    const f = buildOrgForest([P(1, 2, 1), P(2, 1, 2)], dept(2));
    expect([...f.context]).toEqual([1]);
    expect(walk(f).sort()).toEqual([1, 2]);
  });

  it('ancestors and descendants follow the forest', () => {
    const f = buildOrgForest(demo, all);
    expect(forestAncestors(f, 7)).toEqual([5, 1]);
    expect(forestAncestors(f, 1)).toEqual([]);
    expect(forestDescendants(f, 1)).toBe(6);
    expect(forestDescendants(f, 5)).toBe(2);
    const loop = buildOrgForest([P(1, 2, 1), P(2, 1, 1)], all);
    expect(forestAncestors(loop, 2)).toEqual([1]);
  });

  it('people of several companies form separate trees in input order', () => {
    const f = buildOrgForest([P(1, null, 1), P(2, 1, 1), P(10, null, 7), P(11, 10, 7)], all);
    expect(f.roots).toEqual([1, 10]);
  });
});
