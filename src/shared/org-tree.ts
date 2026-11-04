// Reporting-line forest for the organization chart: pure data, no DOM (unit-tested).
// - members: the people the current filter selects; context: the direct manager of a member when that manager is
//   outside the filter (shown, marked, never counted as a member)
// - every visible person appears exactly once; manager_id cycles (incl. self-reference) are broken deterministically
//   and the node where the cycle was cut is flagged, so a broken reports-to never hides people or loops forever

export interface OrgPerson {
  id: number;
  manager_id: number | null;
  department_id: number | null;
}

export interface OrgForestNode {
  id: number;
  /** tree parent actually used for layout (null for a root) */
  parent: number | null;
  /** tree children in input order */
  children: number[];
  /** shown only as the manager of a member outside the filter */
  context: boolean;
  /** the reports-to chain loops; this node was made a root to cut the loop */
  cycle: boolean;
}

export interface OrgForest {
  roots: number[];
  nodes: Map<number, OrgForestNode>;
  members: Set<number>;
  context: Set<number>;
}

/** Builds the forest of people selected by `include` plus their out-of-filter direct managers. Order follows `people`. */
export function buildOrgForest<T extends OrgPerson>(people: readonly T[], include: (p: T) => boolean): OrgForest {
  const byId = new Map(people.map((p) => [p.id, p]));
  const members = new Set(people.filter(include).map((p) => p.id));
  const context = new Set<number>();
  for (const id of members) {
    const m = byId.get(id)?.manager_id;
    if (m !== null && m !== undefined && m !== id && byId.has(m) && !members.has(m)) context.add(m);
  }
  const visible = people.filter((p) => members.has(p.id) || context.has(p.id));
  const visibleIds = new Set(visible.map((p) => p.id));
  // reports-to link inside the visible set (a self-reference is no link)
  const link = (p: T): number | null => (p.manager_id !== null && p.manager_id !== p.id && visibleIds.has(p.manager_id) ? p.manager_id : null);
  const kids = new Map<number, number[]>();
  for (const p of visible) {
    const m = link(p);
    if (m !== null) kids.set(m, [...(kids.get(m) ?? []), p.id]);
  }

  const nodes = new Map<number, OrgForestNode>();
  const roots: number[] = [];
  // iterative depth-first walk; a person reached once is never placed again
  const grow = (root: number, cycle: boolean) => {
    roots.push(root);
    nodes.set(root, { id: root, parent: null, children: [], context: context.has(root), cycle });
    const stack = [root];
    while (stack.length) {
      const id = stack.pop() as number;
      const node = nodes.get(id) as OrgForestNode;
      for (const k of kids.get(id) ?? []) {
        if (nodes.has(k)) continue;
        nodes.set(k, { id: k, parent: id, children: [], context: context.has(k), cycle: false });
        node.children.push(k);
        stack.push(k);
      }
    }
  };
  for (const p of visible) if (link(p) === null) grow(p.id, false);
  // whatever is still unplaced sits on a reports-to loop: cut it at the first such person (input order)
  for (const p of visible) if (!nodes.has(p.id)) grow(p.id, true);
  return { roots, nodes, members, context };
}

/** Tree ancestors of `id` (nearest first) — finite, because the forest has no cycles. */
export function forestAncestors(forest: OrgForest, id: number): number[] {
  const out: number[] = [];
  let p = forest.nodes.get(id)?.parent ?? null;
  while (p !== null) {
    out.push(p);
    p = forest.nodes.get(p)?.parent ?? null;
  }
  return out;
}

/** Number of people below `id` in the forest. */
export function forestDescendants(forest: OrgForest, id: number): number {
  let n = 0;
  const stack = [...(forest.nodes.get(id)?.children ?? [])];
  while (stack.length) {
    const k = stack.pop() as number;
    n++;
    stack.push(...(forest.nodes.get(k)?.children ?? []));
  }
  return n;
}
