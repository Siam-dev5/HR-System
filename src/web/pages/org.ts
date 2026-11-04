// Organization Design: interactive reporting-line chart (SVG) and table view over the real master data.
// Department chips (counts from the API), search, zoom / pan / fit (viewBox: stays sharp, no nested scrolling),
// expand / collapse, employee detail, edit reports-to, validated import, Excel / CSV (server) and PNG / SVG / PDF
// (client) export. The reporting forest comes from shared/org-tree: no duplicate nodes, loops are cut and flagged,
// and a filtered department keeps its out-of-department managers as marked context nodes. No sample data.
import type { OrgDesignResponse, OrgEmployeeNode } from '../../shared/types';
import { buildOrgForest, forestAncestors, type OrgForest } from '../../shared/org-tree';
import { get, post, api, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, link, state } from '../app';
import { icon } from '../icons';
import { avatarUrl } from '../avatar';
import { initialsOf } from '../../shared/avatar';
import { noCompanies, readGridFile } from './attendance';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 210;
const H = 66;
const GX = 18;
const GY = 46;
const PALETTE = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#0d9488'];
// photo circle on the card (card size unchanged; the text moves right of it)
const AV = 40;
const AX = 14;
const AY = (H - AV) / 2;
const TX = AX + AV + 8;
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: Array<SVGElement | string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
/** darker shade of a department colour, so white initials keep ≥ 4.5:1 contrast */
const darken = (hex: string, k = 0.62) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(new Error('read failed'));
  r.readAsDataURL(b);
});

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function renderOrgChart(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    if (!(state.meta?.companies.items.length)) return mount(main, noCompanies());
    const company = params.has('company') ? params.get('company') || null : state.companyId !== null ? String(state.companyId) : null;
    const d = await get<OrgDesignResponse>(`/api/org-design${qs({ company })}`);
    const view = params.get('view') === 'table' ? 'table' : 'chart';
    const go = (next: Record<string, string>) => {
      const p = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) p.set(k, v);
      history.replaceState(null, '', `?${p}`);
      void renderOrgChart(main, p);
    };

    const deptName = (id: number | null) => d.departments.find((x) => x.id === id)?.name ?? '-';
    const pos = (id: number | null) => d.positions.find((x) => x.id === id);
    const colorOf = (deptId: number | null) => (deptId === null ? '#64748b' : PALETTE[deptId % PALETTE.length] as string);
    const byId = new Map(d.employees.map((e) => [e.id, e]));
    // circular photo through the authenticated API (same origin) over the initials; a failed photo leaves the initials
    const avatarNode = (e: OrgEmployeeNode, context: boolean) => {
      const cx = AX + AV / 2;
      const cy = AY + AV / 2;
      const g = svg('g', { class: `org-avatar${e.avatar ? ' has-photo' : ''}`, 'aria-hidden': 'true' },
        svg('circle', { class: 'org-avatar-bg', cx, cy, r: AV / 2, fill: context ? '#e2e8f0' : darken(colorOf(e.department_id)) }),
        svg('text', { class: 'org-avatar-initials', x: cx, y: cy + 5, 'font-size': 14, 'font-weight': 700, 'text-anchor': 'middle', fill: context ? '#475569' : '#ffffff' }, initialsOf(e.name)));
      if (e.avatar) {
        const img = svg('image', { class: 'org-avatar-img', href: avatarUrl(e.id, e.avatar), x: AX, y: AY, width: AV, height: AV, preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#org-avatar-clip)' });
        img.addEventListener('error', () => {
          img.remove();
          g.classList.remove('has-photo');
        });
        g.append(img);
      }
      g.append(svg('circle', { class: 'org-avatar-ring', cx, cy, r: AV / 2, fill: 'none', stroke: '#ffffff', 'stroke-width': 2 }));
      return g;
    };

    // ---- department filter: chips from the department master (counts = the API's active employees per department) ----
    const unassigned = d.employees.filter((e) => e.department_id === null).length;
    let dept = params.get('dept') ?? '';
    if (dept && dept !== 'none' && !d.departments.some((x) => String(x.id) === dept)) dept = '';
    const multiCompany = new Set(d.departments.map((x) => x.company_id)).size > 1;
    const include = (e: OrgEmployeeNode) => (dept === '' ? true : dept === 'none' ? e.department_id === null : e.department_id === Number(dept));
    const chip = (value: string, label: string, count: number, title: string) => h('button', {
      type: 'button', class: `org-chip${count ? '' : ' is-empty'}`, 'data-dept': value, 'aria-pressed': String(dept === value), title,
      onclick: () => setDept(value),
    }, h('span', { class: 'org-chip-label' }, label), h('span', { class: 'org-chip-count' }, String(count)));
    const chips = h('div', { class: 'org-chips', role: 'group', 'aria-label': 'กรองตามหน่วยงาน' },
      chip('', 'ทั้งหมด', d.employees.length, 'พนักงานทั้งหมดในขอบเขตนี้'),
      d.departments.map((x) => {
        const co = multiCompany ? d.companies.find((c) => c.id === x.company_id)?.code : null;
        return chip(String(x.id), co ? `${x.name} · ${co}` : x.name, x.employees, `${x.code} · พนักงานที่สังกัดหน่วยงานนี้โดยตรง ${x.employees} คน`);
      }),
      unassigned ? chip('none', 'ไม่ระบุหน่วยงาน', unassigned, 'พนักงานที่ยังไม่ระบุหน่วยงาน') : null);
    const filterNote = h('p', { class: 'org-filter-note muted', 'aria-live': 'polite' });

    const companySel = h('select', { 'aria-label': 'บริษัท', onchange: () => go({ company: companySel.value }) },
      state.meta?.companies.scope === 'all' ? h('option', { value: '', selected: !d.company }, 'ทุกบริษัท') : null,
      d.companies.map((c) => h('option', { value: String(c.id), selected: c.id === d.company?.id }, c.name)));
    const search = h('input', { type: 'search', placeholder: 'ค้นหาชื่อ / รหัส / ตำแหน่ง', 'aria-label': 'ค้นหาพนักงาน', oninput: () => (view === 'chart' ? draw(true) : redrawTable()) });
    const searchCount = h('span', { class: 'org-search-count muted', 'aria-live': 'polite' });
    const chartBox = h('div', { class: 'org-canvas', tabindex: '0', 'aria-label': 'ผังองค์กร: ลากเพื่อเลื่อน ล้อเมาส์หรือปุ่ม + / − เพื่อซูม', title: 'ลากเพื่อเลื่อน · ล้อเมาส์เพื่อซูม' });
    const side = h('aside', { class: 'card org-side', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
    const collapsed = new Set<number>();
    let forest: OrgForest = buildOrgForest(d.employees, include);
    let current: SVGSVGElement | null = null;
    let selected: number | null = null;
    const nodeAt = new Map<number, { x: number; y: number }>();
    let content = { x: -10, y: 0, w: W + 20, h: H + 20 };

    const matches = (e: OrgEmployeeNode, q: string) => !!q && `${e.emp_code} ${e.name} ${pos(e.position_id)?.title ?? ''}`.toLowerCase().includes(q);

    const showDetail = (e: OrgEmployeeNode) => {
      selected = e.id;
      const p = pos(e.position_id);
      const mgr = e.manager_id ? byId.get(e.manager_id) : undefined;
      const reports = d.employees.filter((x) => x.manager_id === e.id);
      const pick = (x: OrgEmployeeNode) => h('button', { class: 'as-link', onclick: () => { showDetail(x); draw(); focusNode(x.id); } }, `${x.emp_code} ${x.name}`);
      mount(side,
        h('h3', null, e.name), h('div', { class: 'muted' }, e.emp_code),
        forest.context.has(e.id) ? h('p', { class: 'org-context-note' }, 'หัวหน้าจากหน่วยงานอื่น (แสดงเพื่อให้เห็นสายบังคับบัญชา ไม่นับรวมในหน่วยงานที่เลือก)') : null,
        forest.nodes.get(e.id)?.cycle ? h('p', { class: 'org-context-note is-warn' }, 'สายบังคับบัญชาของพนักงานคนนี้วนกลับมาที่ตัวเอง ผังตัดวงไว้ที่จุดนี้ — ควรแก้ "หัวหน้า (Reports To)"') : null,
        h('dl', { class: 'dl' },
          h('dt', null, 'ตำแหน่ง'), h('dd', null, p ? `${p.title}${p.job_grade ? ` (${p.job_grade})` : ''}` : '-'),
          h('dt', null, 'หน่วยงาน'), h('dd', null, deptName(e.department_id)),
          h('dt', null, 'บริษัท'), h('dd', null, d.companies.find((c) => c.id === e.company_id)?.name ?? '-'),
          h('dt', null, 'หัวหน้า (Reports To)'), h('dd', null, mgr ? pick(mgr) : '-'),
          h('dt', null, 'ผู้ใต้บังคับบัญชา'), h('dd', null, reports.length ? h('ul', { class: 'plain' }, reports.map((x) => h('li', null, pick(x)))) : '-'),
          h('dt', null, 'สถานะ'), h('dd', null, optionLabel(e.status)),
          h('dt', null, 'วันเริ่มงาน'), h('dd', null, fmtDate(e.hire_date))),
        h('div', { class: 'toolbar' },
          d.canUpdate ? h('button', { class: 'btn small primary', onclick: () => editEmployee(e) }, 'แก้ไขสายบังคับบัญชา') : null,
          can('employees.view') ? link(`/employees?q=${encodeURIComponent(e.emp_code)}`, 'ข้อมูลพนักงาน', { class: 'btn small' }) : null));
    };

    const editEmployee = (e: OrgEmployeeNode) => {
      const same = d.employees.filter((x) => x.company_id === e.company_id && x.id !== e.id);
      const mgr = h('select', null, h('option', { value: '' }, '— ไม่มี (ระดับบนสุด) —'), same.map((x) => h('option', { value: String(x.id), selected: x.id === e.manager_id }, `${x.emp_code} ${x.name}`)));
      const dep = h('select', null, h('option', { value: '' }, '— ไม่ระบุ —'), d.departments.filter((x) => x.company_id === e.company_id).map((x) => h('option', { value: String(x.id), selected: x.id === e.department_id }, x.name)));
      const ps = h('select', null, h('option', { value: '' }, '— ไม่ระบุ —'), d.positions.map((x) => h('option', { value: String(x.id), selected: x.id === e.position_id }, `${x.title} (${x.code})`)));
      const err = h('div', { class: 'form-msg', role: 'alert' });
      const dlg = modal(`แก้ไข · ${e.emp_code} ${e.name}`, h('div', { class: 'grid-form' },
        h('label', { class: 'field span2' }, h('span', null, 'หัวหน้า (Reports To)'), mgr), h('label', { class: 'field' }, h('span', null, 'หน่วยงาน'), dep), h('label', { class: 'field' }, h('span', null, 'ตำแหน่ง'), ps), err), [
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await api(`/api/org-design/employees/${e.id}`, { method: 'PATCH', body: { manager_id: mgr.value || null, department_id: dep.value || null, position_id: ps.value || null } });
            dlg.close();
            toast('บันทึกแล้ว');
            void renderOrgChart(main, params);
          } catch (x) {
            err.textContent = msg(x);
          }
        } }, 'บันทึก'),
      ]);
    };

    // ---- viewport: the SVG fills the stage; zoom / pan change its viewBox (view.x / view.y = top-left, view.s = px per unit) ----
    const zoomBar = h('div', { class: 'org-zoombar', role: 'toolbar', 'aria-label': 'ควบคุมการแสดงผังองค์กร', 'aria-orientation': 'vertical' });
    const level = h('span', { class: 'org-zoom-level', 'aria-hidden': 'true' }, '100%');
    const vp = { x: 0, y: 0, s: 1 };
    const boxSize = () => ({ w: Math.max(1, chartBox.clientWidth), h: Math.max(1, chartBox.clientHeight) });
    // width covered by the floating toolbar (desktop / tablet); on phones the toolbar sits above the chart
    const reserve = () => (getComputedStyle(zoomBar).position === 'absolute' ? zoomBar.offsetWidth + 20 : 0);
    const apply = () => {
      if (!current) return;
      const { w, h: bh } = boxSize();
      current.setAttribute('viewBox', `${vp.x.toFixed(2)} ${vp.y.toFixed(2)} ${(w / vp.s).toFixed(2)} ${(bh / vp.s).toFixed(2)}`);
      current.dataset.scale = vp.s.toFixed(3);
      level.textContent = `${Math.round(vp.s * 100)}%`;
    };
    const zoomAt = (factor: number, px: number, py: number) => {
      const s = clampScale(vp.s * factor);
      const cx = vp.x + px / vp.s;
      const cy = vp.y + py / vp.s;
      vp.s = s;
      vp.x = cx - px / s;
      vp.y = cy - py / s;
      apply();
    };
    const zoomCentre = (factor: number) => zoomAt(factor, (boxSize().w - reserve()) / 2, boxSize().h / 2);
    const fit = () => {
      const { w, h: bh } = boxSize();
      const aw = Math.max(80, w - reserve() - 24);
      vp.s = clampScale(Math.min(aw / content.w, Math.max(80, bh - 24) / content.h, 1.25));
      vp.x = content.x + content.w / 2 - (w - reserve()) / 2 / vp.s;
      // org charts read top-down: a chart shorter than the stage starts at the top instead of floating mid-way
      vp.y = content.h * vp.s < bh - 24 ? content.y - 12 / vp.s : content.y + content.h / 2 - bh / 2 / vp.s;
      apply();
    };
    const resetView = () => {
      vp.s = 1;
      vp.x = content.x + content.w / 2 - (boxSize().w - reserve()) / 2;
      vp.y = content.y - 16;
      apply();
    };
    const focusNode = (id: number) => {
      const at = nodeAt.get(id);
      if (!at) return;
      if (vp.s < 0.6) vp.s = 0.9;
      const { w, h: bh } = boxSize();
      vp.x = at.x + W / 2 - (w - reserve()) / 2 / vp.s;
      vp.y = at.y + H / 2 - bh / 2 / vp.s;
      apply();
    };
    const expandAll = () => {
      collapsed.clear();
      draw();
    };
    const collapseAll = () => {
      for (const n of forest.nodes.values()) if (n.children.length) collapsed.add(n.id);
      draw();
      fit();
    };
    const zbtn = (act: string, label: string, ico: Parameters<typeof icon>[0], run: () => void) =>
      h('button', { type: 'button', class: 'org-zoom-btn', 'data-act': act, 'aria-label': label, title: label, onclick: run }, icon(ico));
    mount(zoomBar,
      zbtn('zoom-in', 'ซูมเข้า', 'plus', () => zoomCentre(1.25)),
      level,
      zbtn('zoom-out', 'ซูมออก', 'minus', () => zoomCentre(1 / 1.25)),
      h('span', { class: 'org-zoom-sep', 'aria-hidden': 'true' }),
      zbtn('fit', 'พอดีจอ', 'fitScreen', fit),
      zbtn('reset', 'รีเซ็ตมุมมอง (กึ่งกลางผัง 100%)', 'locate', resetView),
      h('span', { class: 'org-zoom-sep', 'aria-hidden': 'true' }),
      zbtn('expand-all', 'ขยายทั้งหมด', 'expandAll', expandAll),
      zbtn('collapse-all', 'ย่อทั้งหมด', 'collapseAll', collapseAll));
    const stage = h('div', { class: 'org-stage' }, chartBox, zoomBar);

    const draw = (fromSearch = false) => {
      const q = search.value.trim().toLowerCase();
      const hits = d.employees.filter((e) => forest.members.has(e.id) && matches(e, q)).map((e) => e.id);
      // a search opens every collapsed ancestor of a match so the result is visible
      if (fromSearch) for (const id of hits) for (const a of forestAncestors(forest, id)) collapsed.delete(a);
      const hitSet = new Set(hits);
      searchCount.textContent = q ? (hits.length ? `พบ ${hits.length} คน` : 'ไม่พบ') : '';

      const widthOf = new Map<number, number>();
      const kidsShown = (id: number) => (collapsed.has(id) ? [] : forest.nodes.get(id)?.children ?? []);
      const measure = (id: number): number => {
        const kids = kidsShown(id);
        const w = kids.length ? Math.max(W, kids.reduce((a, k) => a + measure(k), 0) + GX * (kids.length - 1)) : W;
        widthOf.set(id, w);
        return w;
      };
      const totalW = Math.max(W, forest.roots.reduce((a, r) => a + measure(r), 0) + GX * Math.max(0, forest.roots.length - 1));
      const nodes: SVGElement[] = [];
      const edges: SVGElement[] = [];
      let maxDepth = 0;
      nodeAt.clear();
      const place = (id: number, x0: number, depth: number) => {
        const e = byId.get(id);
        const node = forest.nodes.get(id);
        if (!e || !node) return;
        maxDepth = Math.max(maxDepth, depth);
        const w = widthOf.get(id) ?? W;
        const cx = x0 + w / 2;
        const y = depth * (H + GY) + 10;
        const kids = kidsShown(id);
        let kx = x0 + (w - (kids.reduce((a, k) => a + (widthOf.get(k) ?? W), 0) + GX * Math.max(0, kids.length - 1))) / 2;
        for (const k of kids) {
          const kw = widthOf.get(k) ?? W;
          const kcx = kx + kw / 2;
          const ky = (depth + 1) * (H + GY) + 10;
          edges.push(svg('path', { class: `org-edge${node.context ? ' is-context' : ''}`, d: `M${cx},${y + H} V${y + H + GY / 2} H${kcx} V${ky}`, fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.5, ...(node.context ? { 'stroke-dasharray': '5 4' } : {}) }));
          place(k, kx, depth + 1);
          kx += kw + GX;
        }
        const p = pos(e.position_id);
        const hit = hitSet.has(id);
        const mark = hit || selected === id;
        const x = cx - W / 2;
        nodeAt.set(id, { x, y });
        const third = node.context ? `หัวหน้าจากหน่วยงานอื่น · ${deptName(e.department_id)}` : `${e.emp_code} · ${deptName(e.department_id)}`;
        const label = `${e.name} ${p?.title ?? ''}${node.context ? ' (หัวหน้าจากหน่วยงานอื่น)' : ''}${node.cycle ? ' (สายบังคับบัญชาวนลูป)' : ''}`;
        const g = svg('g', {
          class: `org-node${node.context ? ' is-context' : ''}${node.cycle ? ' is-cycle' : ''}${hit ? ' is-hit' : ''}${selected === id ? ' is-selected' : ''}`,
          'data-id': id, transform: `translate(${x},${y})`, tabindex: 0, role: 'button', 'aria-label': label,
          ...(node.children.length ? { 'aria-expanded': String(!collapsed.has(id)) } : {}),
        },
          svg('rect', { class: 'org-card', width: W, height: H, rx: 8, fill: node.context ? '#f8fafc' : '#ffffff', stroke: mark ? '#f59e0b' : node.cycle ? '#dc2626' : node.context ? '#94a3b8' : '#cbd5e1', 'stroke-width': mark ? 3 : node.cycle ? 2 : 1, ...(node.context && !mark ? { 'stroke-dasharray': '5 4' } : {}) }),
          svg('rect', { class: 'org-stripe', width: 6, height: H, rx: 3, fill: node.context ? '#cbd5e1' : colorOf(e.department_id) }),
          avatarNode(e, node.context),
          svg('text', { class: 'org-t1', x: TX, y: 20, 'font-size': 13, 'font-weight': 700, fill: node.context ? '#475569' : '#0f172a' }, clip(e.name, node.cycle ? 13 : 19)),
          svg('text', { class: 'org-t2', x: TX, y: 38, 'font-size': 11.5, fill: '#334155' }, clip(p?.title ?? 'ไม่ระบุตำแหน่ง', 22)),
          svg('text', { class: 'org-t3', x: TX, y: 55, 'font-size': 10.5, fill: node.context ? '#475569' : '#64748b' }, clip(third, 25)));
        if (node.cycle) g.append(svg('g', { class: 'org-cycle-badge', transform: `translate(${W - 58},6)` }, svg('rect', { width: 52, height: 17, rx: 8.5, fill: '#fee2e2', stroke: '#dc2626' }), svg('text', { x: 26, y: 12.5, 'font-size': 10, 'text-anchor': 'middle', fill: '#b91c1c' }, 'วนลูป')));
        if (node.children.length) {
          const closed = collapsed.has(id);
          g.append(svg('g', { class: 'org-toggle', transform: `translate(${W / 2 - 13},${H - 13})`, 'data-toggle': id },
            svg('circle', { cx: 13, cy: 13, r: 18, fill: 'transparent' }),
            svg('circle', { class: 'org-toggle-dot', cx: 13, cy: 13, r: 12, fill: closed ? '#2563eb' : '#f1f5f9', stroke: closed ? '#1d4ed8' : '#94a3b8' }),
            svg('text', { class: 'org-toggle-text', x: 13, y: 17, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle', fill: closed ? '#ffffff' : '#0f172a' }, closed ? `+${node.children.length}` : '−')));
        }
        nodes.push(g);
      };
      let x = 0;
      for (const r of forest.roots) {
        place(r, x, 0);
        x += (widthOf.get(r) ?? W) + GX;
      }
      content = { x: -10, y: 0, w: totalW + 20, h: (maxDepth + 1) * (H + GY) + 10 };
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      current = svg('svg', { xmlns: SVG_NS, width: '100%', height: '100%', preserveAspectRatio: 'xMinYMin meet', 'font-family': font, role: 'img', 'aria-label': 'ผังสายบังคับบัญชา' },
        svg('defs', {}, svg('clipPath', { id: 'org-avatar-clip', clipPathUnits: 'objectBoundingBox' }, svg('circle', { cx: 0.5, cy: 0.5, r: 0.5 }))),
        svg('g', {}, ...edges), svg('g', {}, ...nodes));
      mount(chartBox, forest.roots.length ? current : h('div', { class: 'empty' }, dept ? 'ไม่มีพนักงานในหน่วยงานนี้' : 'ไม่มีพนักงานในขอบเขตนี้'));
      apply();
      const ctx = forest.context.size;
      filterNote.textContent = dept
        ? `แสดง ${forest.members.size} คนในหน่วยงานที่เลือก${ctx ? ` · หัวหน้าจากหน่วยงานอื่น ${ctx} คน (กรอบเส้นประ ไม่นับรวม)` : ''}`
        : '';
      if (fromSearch && hits[0] !== undefined) focusNode(hits[0]);
    };

    const setDept = (value: string) => {
      dept = value;
      const p = new URLSearchParams(location.search);
      if (value) p.set('dept', value);
      else p.delete('dept');
      history.replaceState(null, '', `?${p}`);
      for (const b of chips.querySelectorAll<HTMLElement>('.org-chip')) b.setAttribute('aria-pressed', String(b.dataset.dept === value));
      forest = buildOrgForest(d.employees, include);
      collapsed.clear();
      // the detail panel reflects the new filter (e.g. "manager from another department" only applies inside it)
      const still = selected !== null && forest.nodes.has(selected) ? byId.get(selected) : undefined;
      if (still) showDetail(still);
      else {
        selected = null;
        mount(side, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
      }
      if (view === 'table') return redrawTable();
      draw(true);
      if (!search.value.trim()) fit();
    };

    // ---- pointer: drag to pan (also on nodes, after a small threshold), two fingers to pinch-zoom; wheel zooms ----
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    let pinch: { d: number; s: number } | null = null;
    let suppressClick = false;
    const local = (ev: PointerEvent | WheelEvent) => {
      const r = chartBox.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const pair = () => {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    chartBox.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      pointers.set(ev.pointerId, local(ev));
      if (pointers.size === 1) drag = { x: ev.clientX, y: ev.clientY, vx: vp.x, vy: vp.y, moved: false };
      else if (pointers.size === 2) {
        pinch = { d: pair().d, s: vp.s };
        drag = null;
        chartBox.setPointerCapture(ev.pointerId);
      }
    });
    chartBox.addEventListener('pointermove', (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, local(ev));
      if (pinch && pointers.size === 2) {
        const p = pair();
        zoomAt(clampScale(pinch.s * (p.d / pinch.d)) / vp.s, p.mx, p.my);
        suppressClick = true;
        return;
      }
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        chartBox.setPointerCapture(ev.pointerId);
        chartBox.classList.add('is-panning');
      }
      if (drag.moved) {
        vp.x = drag.vx - dx / vp.s;
        vp.y = drag.vy - dy / vp.s;
        apply();
      }
    });
    const release = (ev: PointerEvent) => {
      if (drag?.moved) suppressClick = true;
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        drag = null;
        chartBox.classList.remove('is-panning');
      }
    };
    chartBox.addEventListener('pointerup', release);
    chartBox.addEventListener('pointercancel', release);
    chartBox.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = local(ev);
      zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    }, { passive: false });
    new ResizeObserver(() => apply()).observe(chartBox);

    const toggle = (id: number) => {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      draw();
    };
    chartBox.addEventListener('click', (ev) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const t = (ev.target as Element).closest('[data-toggle]');
      if (t) return toggle(Number(t.getAttribute('data-toggle')));
      const n = (ev.target as Element).closest('[data-id]');
      const e = n ? byId.get(Number(n.getAttribute('data-id'))) : undefined;
      if (e) {
        showDetail(e);
        draw();
      }
    });
    chartBox.addEventListener('keydown', (ev) => {
      const n = (ev.target as Element).closest?.('[data-id]');
      const id = n ? Number(n.getAttribute('data-id')) : null;
      if (id !== null && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        const e = byId.get(id);
        if (e) showDetail(e);
        return;
      }
      if (id !== null && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && forest.nodes.get(id)?.children.length) {
        ev.preventDefault();
        if ((ev.key === 'ArrowRight') === collapsed.has(id)) toggle(id);
        (chartBox.querySelector(`[data-id="${id}"]`) as SVGGElement | null)?.focus();
        return;
      }
      const step = 60 / vp.s;
      const keys: Record<string, () => void> = {
        '+': () => zoomCentre(1.25), '=': () => zoomCentre(1.25), '-': () => zoomCentre(1 / 1.25), '0': resetView, f: fit,
        ArrowUp: () => { vp.y -= step; apply(); }, ArrowDown: () => { vp.y += step; apply(); },
        ArrowLeft: () => { vp.x -= step; apply(); }, ArrowRight: () => { vp.x += step; apply(); },
      };
      const run = keys[ev.key];
      if (run && (id === null || ev.key.length === 1)) {
        ev.preventDefault();
        run();
      }
    });

    // exports always cover the whole chart, whatever the current zoom / pan
    const exportSvgText = async (): Promise<string | null> => {
      if (!current) return null;
      const clone = current.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('viewBox', `${content.x} ${content.y} ${content.w} ${content.h}`);
      clone.setAttribute('width', String(content.w));
      clone.setAttribute('height', String(content.h));
      clone.removeAttribute('data-scale');
      clone.insertBefore(svg('rect', { x: content.x, y: content.y, width: content.w, height: content.h, fill: '#ffffff' }), clone.firstChild);
      // photos come from the authenticated API: inline them so the exported file stands alone (initials if one fails)
      for (const img of [...clone.querySelectorAll('image')]) {
        try {
          const r = await fetch(img.getAttribute('href') as string, { credentials: 'same-origin' });
          if (!r.ok) throw new Error(String(r.status));
          img.setAttribute('href', await blobToDataUrl(await r.blob()));
        } catch {
          img.remove();
        }
      }
      return new XMLSerializer().serializeToString(clone);
    };
    const fileBase = `organization${d.company ? `-${d.company.code}` : ''}`;
    const exportPng = async () => {
      const text = await exportSvgText();
      if (!text) return;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const k = Math.min(2, 16000 / Math.max(content.w, content.h));
        canvas.width = Math.round(content.w * k);
        canvas.height = Math.round(content.h * k);
        const ctx = canvas.getContext('2d');
        if (!ctx) return toast('เบราว์เซอร์ไม่รองรับการสร้างรูปภาพ', 'error');
        ctx.scale(k, k);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? download(`${fileBase}.png`, b) : toast('สร้างไฟล์ PNG ไม่สำเร็จ', 'error')), 'image/png');
      };
      img.onerror = () => toast('สร้างไฟล์ PNG ไม่สำเร็จ', 'error');
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    };
    const exportPdf = () => {
      if (view !== 'chart') return go({ view: 'chart' });
      if (current) current.setAttribute('viewBox', `${content.x} ${content.y} ${content.w} ${content.h}`);
      document.body.classList.add('print-org');
      const done = () => {
        document.body.classList.remove('print-org');
        window.removeEventListener('afterprint', done);
        apply();
      };
      window.addEventListener('afterprint', done);
      window.print();
    };
    const exportMenu = h('details', { class: 'menu-details', ontoggle: (e: Event) => {
      const el = e.currentTarget as HTMLDetailsElement;
      if (!el.open) return;
      // keep the menu inside the screen wherever the toolbar wrapped the button
      const pop = el.querySelector<HTMLElement>('.menu-pop');
      if (pop) {
        pop.style.left = '';
        pop.style.right = '';
        if (pop.getBoundingClientRect().right > innerWidth - 8) {
          pop.style.left = 'auto';
          pop.style.right = '0';
        }
        const r = pop.getBoundingClientRect();
        if (r.left < 8) {
          pop.style.right = 'auto';
          pop.style.left = `${8 - el.getBoundingClientRect().left}px`;
        }
      }
      const close = (ev: Event) => {
        if (ev instanceof KeyboardEvent ? ev.key === 'Escape' : !el.contains(ev.target as Node)) {
          el.open = false;
          document.removeEventListener('click', close, true);
          document.removeEventListener('keydown', close, true);
        }
      };
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', close, true);
    } }, h('summary', { class: 'btn' }, 'Export ▾'),
      h('div', { class: 'menu-pop' },
        h('a', { class: 'menu-link', href: `${basePath()}/api/org-design/export.xlsx${qs({ company: d.company?.id })}`, download: true }, 'Excel (.xlsx)'),
        h('a', { class: 'menu-link', href: `${basePath()}/api/org-design/export.csv${qs({ company: d.company?.id })}`, download: true }, 'CSV'),
        view === 'chart' ? [
          h('button', { class: 'menu-link', onclick: exportPng }, 'PNG'),
          h('button', { class: 'menu-link', onclick: async () => { const t = await exportSvgText(); if (t) download(`${fileBase}.svg`, new Blob([t], { type: 'image/svg+xml' })); } }, 'SVG'),
          h('button', { class: 'menu-link', onclick: exportPdf }, 'PDF (พิมพ์)'),
        ] : null));

    const s = d.stats;
    const kpi = (label: string, value: string | number, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)));
    const tableView = () => h('div', { class: 'stack' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['รหัส', 'ชื่อ-นามสกุล', 'หน่วยงาน', 'ตำแหน่ง', 'Grade', 'หัวหน้า', 'ผู้ใต้บังคับบัญชา'].map((t) => h('th', null, t)))),
        h('tbody', null, d.employees.filter((e) => include(e) && (!search.value.trim() || matches(e, search.value.trim().toLowerCase()))).map((e) => {
          const m = e.manager_id ? byId.get(e.manager_id) : undefined;
          return h('tr', null, h('td', null, e.emp_code), h('td', null, e.name), h('td', null, deptName(e.department_id)), h('td', null, pos(e.position_id)?.title ?? '-'), h('td', null, pos(e.position_id)?.job_grade ?? '-'),
            h('td', null, m ? `${m.emp_code} ${m.name}` : '-'), h('td', { class: 'num' }, String(d.employees.filter((x) => x.manager_id === e.id).length)));
        })))),
      h('h3', null, 'อัตรากำลังตามตำแหน่ง (Approved / Occupied / Vacant)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['รหัส', 'ตำแหน่ง', 'หน่วยงาน', 'Grade', 'อัตราอนุมัติ', 'มีคนครอง', 'ว่าง (Vacant)', 'เกินอัตรา (Over)'].map((t) => h('th', null, t)))),
        h('tbody', null, d.positions.filter((p) => dept === '' || (dept === 'none' ? p.department_id === null : p.department_id === Number(dept))).map((p) => h('tr', null,
          h('td', null, p.code), h('td', null, p.title), h('td', null, deptName(p.department_id)), h('td', null, p.job_grade ?? '-'),
          h('td', { class: 'num' }, String(p.approved)), h('td', { class: 'num' }, String(p.occupied)),
          h('td', { class: 'num' }, p.vacant ? h('span', { class: 'badge-status s-pending' }, String(p.vacant)) : '0'),
          h('td', { class: 'num' }, p.over ? h('span', { class: 'badge-status s-rejected' }, `+${p.over}`) : '0')))))));

    const tableBox = h('div');
    const redrawTable = () => mount(tableBox, tableView());

    mount(main,
      h('div', { class: 'toolbar org-toolbar' },
        d.companies.length ? h('label', { class: 'field inline' }, h('span', null, 'บริษัท'), companySel) : null,
        search, searchCount,
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'มุมมอง' },
          h('button', { class: `btn small ${view === 'chart' ? 'primary' : ''}`, 'aria-pressed': view === 'chart' ? 'true' : 'false', onclick: () => go({ view: 'chart' }) }, 'ผังองค์กร'),
          h('button', { class: `btn small ${view === 'table' ? 'primary' : ''}`, 'aria-pressed': view === 'table' ? 'true' : 'false', onclick: () => go({ view: 'table' }) }, 'ตาราง')),
        h('div', { class: 'spacer' }),
        d.canExport ? exportMenu : null,
        d.canImport ? h('button', { class: 'btn small', onclick: () => importDialog(d, () => void renderOrgChart(main, params)) }, 'Import') : null,
        can('employees.create') ? link('/employees', '+ เพิ่มพนักงาน', { class: 'btn small' }) : null),
      chips, filterNote,
      h('div', { class: 'kpis' }, kpi('พนักงาน', s.employees), kpi('หน่วยงาน', s.departments), kpi('ระดับชั้นการบังคับบัญชา', s.levels), kpi('ตำแหน่งที่มีคนครอง', `${s.occupiedPositions} / ${s.positions}`),
        kpi('อัตราอนุมัติ (Approved)', s.approved), kpi('มีคนครอง (Occupied)', s.occupied), kpi('ว่าง (Vacant)', s.vacant, s.vacant ? 'kpi-warn' : ''), kpi('เกินอัตรา (Over)', s.over, s.over ? 'kpi-bad' : '')),
      view === 'chart' ? h('div', { class: 'org-layout' }, stage, side) : tableBox);
    if (view === 'chart') {
      draw();
      requestAnimationFrame(() => fit());
    } else redrawTable();
  } catch (e) {
    mount(main, errorBox(e));
  }
}

function importDialog(d: OrgDesignResponse, onDone: () => void): void {
  type Preview = { rows: Array<{ rowNo: number; emp_code: string; name: string | null; changes: Array<{ label: string; from: string | null; to: string | null }>; errors: string[] }>; stats: { total: number; changed: number; unchanged: number; errors: number } };
  const file = h('input', { type: 'file', accept: '.xlsx,.csv', 'aria-label': 'ไฟล์โครงสร้างองค์กร' });
  const out = h('div', { class: 'stack' });
  const skip = h('input', { type: 'checkbox' });
  let grid: unknown[][] = [];
  const body = () => ({ company_id: d.company?.id ?? null, grid });
  const previewBtn = h('button', { class: 'btn', onclick: async () => {
    try {
      if (!file.files?.[0]) return toast('กรุณาเลือกไฟล์', 'error');
      grid = (await readGridFile(file.files[0])).grid;
      const p = await post<Preview>('/api/org-design/import/preview', body());
      const show = p.rows.filter((r) => r.errors.length || r.changes.length);
      mount(out,
        h('p', null, `ทั้งหมด ${p.stats.total} แถว · เปลี่ยนแปลง ${p.stats.changed} · ไม่เปลี่ยน ${p.stats.unchanged} · ผิดพลาด ${p.stats.errors}`),
        show.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, h('th', null, 'แถว'), h('th', null, 'พนักงาน'), h('th', null, 'การเปลี่ยนแปลง / ข้อผิดพลาด'))),
          h('tbody', null, show.map((r) => h('tr', { class: r.errors.length ? 'row-error' : '' }, h('td', null, String(r.rowNo)), h('td', null, `${r.emp_code} ${r.name ?? ''}`),
            h('td', null, r.errors.length ? h('ul', { class: 'issues' }, r.errors.map((x) => h('li', { class: 'issue-error' }, x))) : r.changes.map((c) => h('div', null, `${c.label}: ${c.from ?? '-'} → ${c.to ?? '-'}`)))))))) : h('div', { class: 'empty' }, 'ไม่มีการเปลี่ยนแปลง'),
        p.stats.errors ? h('label', { class: 'check' }, skip, ` นำเข้าเฉพาะรายการที่ถูกต้อง (ข้าม ${p.stats.errors} แถว)`) : null);
      applyBtn.disabled = p.stats.changed === 0;
    } catch (e) {
      mount(out, errorBox(e));
    }
  } }, 'ตรวจสอบ (Preview)');
  const applyBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
    try {
      const r = await post<{ changed: number; skipped: number }>('/api/org-design/import', { ...body(), skip_invalid: skip.checked });
      dlg.close();
      toast(`นำเข้าแล้ว ${r.changed} รายการ`);
      onDone();
    } catch (e) {
      toast(msg(e), 'error');
    }
  } }, 'ยืนยันนำเข้า');
  const dlg = modal('Import โครงสร้างองค์กร', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'ปรับหัวหน้า (Reports To) หน่วยงาน และตำแหน่งของพนักงานที่มีอยู่แล้วเท่านั้น ไม่สร้างหรือลบพนักงาน ทุกการเปลี่ยนแปลงต้องผ่าน Preview และบันทึก Audit Log'),
    h('a', { class: 'btn small', href: `${basePath()}/api/org-design/template.xlsx${qs({ company: d.company?.id })}`, download: true }, 'ดาวน์โหลด Excel Template (ข้อมูลปัจจุบัน)'),
    h('label', { class: 'field' }, h('span', null, 'ไฟล์ (.xlsx / .csv)'), file), out), [h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'), previewBtn, applyBtn]);
}
