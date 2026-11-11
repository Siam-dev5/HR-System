// Organization Design: interactive reporting-line chart (SVG) and table view over the real master data.
// Department chips (counts from the API), search, zoom / pan / fit (viewBox: stays sharp, no nested scrolling),
// expand / collapse, employee detail, edit reports-to, validated import, Excel / CSV (server) and PNG / SVG / PDF
// (client) export. The reporting forest comes from shared/org-tree: no duplicate nodes, loops are cut and flagged,
// and a filtered department keeps its out-of-department managers as marked context nodes. No sample data.
// Layout (shared/org-layout, master template): a tidy tree spread left / centre / right with each manager centred over
// its teams, 5 level bands from the exact Position Title → Level table (shared/org-levels) with the labels in a rail
// fixed to the left edge, the reporting line from manager_id only, Staff / Admin stacked in 1–3 columns under their
// own manager, one group per company, people whose manager is in another company in a titled frame (no line across
// companies), people without a manager in a "ไม่มีสายบังคับบัญชา" block. Card borders take the department colour
// (legend above the chart). Unmapped titles carry a marker.
import type { OrgDesignResponse, OrgEmployeeNode } from '../../shared/types';
import { buildOrgForest, forestAncestors, mergeForests, type OrgForest } from '../../shared/org-tree';
import { ORG_LEVEL_LABELS, positionLevel, type PositionLevel } from '../../shared/org-levels';
import { BAND_LABEL_W, CARD_H, CARD_W, FRAME_PAD, GAP_Y, layoutOrg, type OrgLayout } from '../../shared/org-layout';
import { NO_DEPT_COLOR, departmentColors } from '../../shared/org-colors';
import { get, post, api, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, link, state } from '../app';
import { icon } from '../icons';
import { avatarUrl } from '../avatar';
import { initialsOf } from '../../shared/avatar';
import { noCompanies, readGridFile } from './attendance';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = CARD_W;
const H = CARD_H;
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
    // department colours: department master order of this scope, only departments that have people (plus a department
    // of another scope that someone still points at); the same department keeps its colour across filters
    const deptIds = [...d.departments.map((x) => x.id), ...new Set(d.employees.map((e) => e.department_id).filter((x): x is number => x !== null && !d.departments.some((y) => y.id === x)))]
      .filter((id) => d.employees.some((e) => e.department_id === id));
    const deptColor = departmentColors(deptIds);
    const deptRank = new Map(deptIds.map((id, i) => [id, i]));
    const colorOf = (deptId: number | null) => (deptId === null ? NO_DEPT_COLOR : deptColor.get(deptId) ?? NO_DEPT_COLOR);
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
    // one forest per company (company order of the API): no reporting line is drawn across companies
    const companyOrder = [...new Set([...d.companies.map((c) => c.id), ...d.employees.map((e) => e.company_id)])].filter((id) => d.employees.some((e) => e.company_id === id));
    const buildForest = () => mergeForests(companyOrder.map((cid) => buildOrgForest(d.employees.filter((e) => e.company_id === cid), include)));
    const levels = new Map<number, PositionLevel>(d.employees.map((e) => [e.id, positionLevel(pos(e.position_id)?.title)]));
    const levelInfo = (id: number): PositionLevel => levels.get(id) ?? { level: 5, mapped: false };
    const levelText = (l: PositionLevel) => `L${l.level} · ${ORG_LEVEL_LABELS[l.level]}${l.mapped ? '' : ' (Unmapped Level)'}`;
    const companyName = (id: number) => d.companies.find((c) => c.id === id)?.name ?? '-';
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
    const unmappedNote = h('p', { class: 'org-unmapped-note', 'aria-live': 'polite' });
    // legend: the departments of the cards on screen (rebuilt on every draw, so filters keep it true)
    const legend = h('div', { class: 'org-legend', role: 'list', 'aria-label': 'สีกรอบตามหน่วยงาน' });
    const drawLegend = (lay: OrgLayout) => {
      const counts = new Map<number | null, { n: number; context: boolean }>();
      for (const id of lay.nodes.keys()) {
        const e = byId.get(id);
        if (!e) continue;
        const c = counts.get(e.department_id) ?? { n: 0, context: true };
        c.n++;
        c.context &&= forest.context.has(id);
        counts.set(e.department_id, c);
      }
      const keys = [...counts.keys()].sort((a, b) => (a === null ? 1e9 : deptRank.get(a) ?? 1e8) - (b === null ? 1e9 : deptRank.get(b) ?? 1e8));
      const label = (id: number | null) => {
        if (id === null) return 'ไม่ระบุหน่วยงาน';
        const x = d.departments.find((y) => y.id === id);
        if (!x) return `หน่วยงานนอกขอบเขต (#${id})`;
        const co = multiCompany ? d.companies.find((c) => c.id === x.company_id)?.code : null;
        return co ? `${x.name} · ${co}` : x.name;
      };
      mount(legend, keys.length ? [
        h('span', { class: 'org-legend-title' }, 'หน่วยงาน'),
        keys.map((id) => {
          const c = counts.get(id) as { n: number; context: boolean };
          return h('span', { class: `org-legend-item${c.context ? ' is-context' : ''}`, role: 'listitem', 'data-dept': id === null ? 'none' : String(id), 'data-color': colorOf(id), title: c.context ? 'หัวหน้าจากหน่วยงานอื่น (แสดงเพื่อให้เห็นสายบังคับบัญชา)' : `${c.n} คนในผัง` },
            h('span', { class: 'org-legend-swatch', style: `border-color:${colorOf(id)}`, 'aria-hidden': 'true' }), h('span', null, label(id)), h('span', { class: 'org-legend-count' }, String(c.n)));
        }),
      ] : null);
    };
    // level labels: a rail fixed to the left edge of the chart, each label on the line of its band (follows zoom / pan)
    const levelRail = h('div', { class: 'org-level-rail', 'aria-hidden': 'true' });
    let bands: OrgLayout['bands'] = [];

    const companySel = h('select', { 'aria-label': 'บริษัท', onchange: () => go({ company: companySel.value }) },
      state.meta?.companies.scope === 'all' ? h('option', { value: '', selected: !d.company }, 'ทุกบริษัท') : null,
      d.companies.map((c) => h('option', { value: String(c.id), selected: c.id === d.company?.id }, c.name)));
    const search = h('input', { type: 'search', placeholder: 'ค้นหาชื่อ / รหัส / ตำแหน่ง', 'aria-label': 'ค้นหาพนักงาน', oninput: () => (view === 'chart' ? draw(true) : redrawTable()) });
    const searchCount = h('span', { class: 'org-search-count muted', 'aria-live': 'polite' });
    const chartBox = h('div', { class: 'org-canvas', tabindex: '0', 'aria-label': 'ผังองค์กร: ลากเพื่อเลื่อน ล้อเมาส์หรือปุ่ม + / − เพื่อซูม', title: 'ลากเพื่อเลื่อน · ล้อเมาส์เพื่อซูม' });
    // employee detail: a drawer over the right edge of the chart (desktop / laptop); the chart keeps its full size and
    // its zoom / pan when the drawer opens or closes. Below 900px it is the static panel under the chart, as before.
    const side = h('aside', { class: 'card org-side', 'aria-live': 'polite', 'aria-label': 'รายละเอียดพนักงาน' }, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
    const READABLE = 0.7;
    const collapsed = new Set<number>();
    let forest: OrgForest = buildForest();
    let current: SVGSVGElement | null = null;
    let selected: number | null = null;
    const nodeAt = new Map<number, { x: number; y: number; orphan: boolean }>();
    let content = { x: -10, y: 0, w: W + 20, h: H + 20 };
    // exports and print: the chart plus the level labels on its left
    let exportBox = { ...content };

    const matches = (e: OrgEmployeeNode, q: string) => !!q && `${e.emp_code} ${e.name} ${pos(e.position_id)?.title ?? ''}`.toLowerCase().includes(q);

    const showDetail = (e: OrgEmployeeNode) => {
      selected = e.id;
      openDrawer();
      const p = pos(e.position_id);
      const mgr = e.manager_id ? byId.get(e.manager_id) : undefined;
      const reports = d.employees.filter((x) => x.manager_id === e.id);
      const lv = levelInfo(e.id);
      const pick = (x: OrgEmployeeNode) => h('button', { class: 'as-link', onclick: () => { showDetail(x); draw(); focusNode(x.id); } }, `${x.emp_code} ${x.name}`);
      mount(side,
        h('div', { class: 'org-drawer-head' },
          h('div', null, h('h3', null, e.name), h('div', { class: 'muted' }, e.emp_code)),
          h('button', { type: 'button', class: 'org-drawer-close', 'data-act': 'close-detail', 'aria-label': 'ปิดรายละเอียด', title: 'ปิดรายละเอียด (Esc)', onclick: () => closeDrawer() }, '×')),
        forest.context.has(e.id) ? h('p', { class: 'org-context-note' }, 'หัวหน้าจากหน่วยงานอื่น (แสดงเพื่อให้เห็นสายบังคับบัญชา ไม่นับรวมในหน่วยงานที่เลือก)') : null,
        mgr && mgr.company_id !== e.company_id ? h('p', { class: 'org-context-note' }, `หัวหน้าอยู่ต่างบริษัท (${companyName(mgr.company_id)}) — ผังแสดงแยกตามบริษัท`) : null,
        lv.mapped ? null : h('p', { class: 'org-context-note is-unmapped' }, `Unmapped Level: ตำแหน่ง "${p?.title ?? 'ไม่ระบุตำแหน่ง'}" ยังไม่อยู่ใน Mapping ระดับ — แสดงเป็น L5 ชั่วคราว`),
        forest.nodes.get(e.id)?.cycle ? h('p', { class: 'org-context-note is-warn' }, 'สายบังคับบัญชาของพนักงานคนนี้วนกลับมาที่ตัวเอง ผังตัดวงไว้ที่จุดนี้ — ควรแก้ "หัวหน้า (Reports To)"') : null,
        h('dl', { class: 'dl' },
          h('dt', null, 'ตำแหน่ง'), h('dd', null, p ? `${p.title}${p.job_grade ? ` (${p.job_grade})` : ''}` : '-'),
          h('dt', null, 'ระดับในผัง'), h('dd', null, levelText(lv)),
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
    // what fits / centring avoid on the right: the toolbar, and the drawer while it is open (it moves the toolbar left)
    const reserve = () => {
      if (getComputedStyle(zoomBar).position !== 'absolute') return 0;
      return Math.max(0, chartBox.getBoundingClientRect().right - zoomBar.getBoundingClientRect().left) + 8;
    };
    // … and on the left: the level label rail
    const leftReserve = () => (levelRail.hidden ? 0 : levelRail.offsetWidth + 6);
    const apply = () => {
      if (!current) return;
      const { w, h: bh } = boxSize();
      current.setAttribute('viewBox', `${vp.x.toFixed(2)} ${vp.y.toFixed(2)} ${(w / vp.s).toFixed(2)} ${(bh / vp.s).toFixed(2)}`);
      current.dataset.scale = vp.s.toFixed(3);
      level.textContent = `${Math.round(vp.s * 100)}%`;
      // the rail sits over the canvas (also when the toolbar is above it on phones); labels follow their band
      levelRail.style.top = `${chartBox.offsetTop}px`;
      levelRail.style.left = `${chartBox.offsetLeft}px`;
      levelRail.style.height = `${chartBox.clientHeight}px`;
      for (const el of levelRail.querySelectorAll<HTMLElement>('[data-level]')) {
        const b = bands.find((x) => x.level === Number(el.dataset.level));
        if (b) el.style.transform = `translateY(${((b.y + H / 2 - vp.y) * vp.s - el.offsetHeight / 2).toFixed(1)}px)`;
      }
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
    // the free part of the stage, between the level rail and the toolbar / drawer (screen px)
    const area = () => {
      const l = leftReserve();
      return { l, w: Math.max(80, boxSize().w - reserve() - l) };
    };
    const zoomCentre = (factor: number) => zoomAt(factor, area().l + area().w / 2, boxSize().h / 2);
    const wholeScale = () => {
      const { h: bh } = boxSize();
      return clampScale(Math.min(Math.max(80, area().w - 24) / content.w, Math.max(80, bh - 24) / content.h, 1.25));
    };
    // Whole Chart Fit: the entire chart in view, whatever the scale
    const fit = () => {
      const { h: bh } = boxSize();
      const a = area();
      vp.s = wholeScale();
      vp.x = content.x + content.w / 2 - (a.l + a.w / 2) / vp.s;
      // org charts read top-down: a chart shorter than the stage starts at the top instead of floating mid-way
      vp.y = content.h * vp.s < bh - 24 ? content.y - 12 / vp.s : content.y + content.h / 2 - bh / 2 / vp.s;
      apply();
    };
    // Readable Fit: the whole-chart scale when that is already readable, otherwise 70 % from the top (MD / AMD in view);
    // nothing is cropped — the rest of the chart is a pan / zoom away
    const readableFit = () => {
      const whole = wholeScale();
      if (whole >= READABLE) return fit();
      vp.s = READABLE;
      const { l: al, w: aw } = area();
      const placed = [...nodeAt.entries()].filter(([, n]) => !n.orphan);
      const topLevel = placed.filter(([id]) => levelInfo(id).level <= 2);
      const minY = Math.min(...placed.map(([, n]) => n.y));
      const anchor = topLevel.length ? topLevel : placed.filter(([, n]) => n.y === minY);
      const ax0 = Math.min(...anchor.map(([, n]) => n.x));
      const ax1 = Math.max(...anchor.map(([, n]) => n.x + W));
      if (content.w * vp.s <= aw) vp.x = content.x + content.w / 2 - (al + aw / 2) / vp.s;
      else {
        // centre on MD / AMD when they fit side by side, else start at the left-most of them; stay inside the chart
        // (when the left-most of them is close to the chart's left edge, start at that edge: the first company reads from its start)
        const left = Math.min(...placed.map(([, n]) => n.x));
        const want = ax1 - ax0 <= aw / vp.s - 48 / vp.s ? (ax0 + ax1) / 2 - aw / 2 / vp.s : ax0 + W - left <= aw / vp.s - 48 / vp.s ? content.x : ax0 - 24 / vp.s;
        vp.x = Math.min(Math.max(want, content.x), content.x + content.w - aw / vp.s) - al / vp.s;
      }
      vp.y = content.y - 12 / vp.s; // the top of the chart: company headers and MD / AMD
      apply();
    };
    const resetView = () => {
      vp.s = 1;
      vp.x = content.x + content.w / 2 - (area().l + area().w / 2);
      vp.y = content.y - 16;
      apply();
    };
    const focusNode = (id: number) => {
      const at = nodeAt.get(id);
      if (!at) return;
      if (vp.s < 0.6) vp.s = 0.9;
      const { h: bh } = boxSize();
      vp.x = at.x + W / 2 - (area().l + area().w / 2) / vp.s;
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
      h('button', { type: 'button', class: 'org-zoom-btn org-zoom-text', 'data-act': 'readable-fit', 'aria-label': 'Readable Fit · พอดีจอแบบอ่านได้ (≥ 70%)', title: 'Readable Fit · พอดีจอแบบอ่านได้ (≥ 70%)', onclick: readableFit }, 'Aa'),
      zbtn('fit', 'Whole Chart Fit · พอดีจอทั้งผัง', 'fitScreen', fit),
      zbtn('reset', 'รีเซ็ตมุมมอง (กึ่งกลางผัง 100%)', 'locate', resetView),
      h('span', { class: 'org-zoom-sep', 'aria-hidden': 'true' }),
      zbtn('expand-all', 'ขยายทั้งหมด', 'expandAll', expandAll),
      zbtn('collapse-all', 'ย่อทั้งหมด', 'collapseAll', collapseAll));
    const stage = h('div', { class: 'org-stage' }, chartBox, levelRail, zoomBar, side);
    function openDrawer(): void {
      stage.classList.add('has-drawer');
    }
    function closeDrawer(): void {
      stage.classList.remove('has-drawer');
      selected = null;
      mount(side, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
      draw(); // only the highlight goes; the viewBox (zoom / pan) is kept
      chartBox.focus({ preventScroll: true });
    }
    // Escape closes the drawer wherever the focus is (a click redraws the SVG, so focus may be on the page);
    // not while a dialog is open, and the listener removes itself once this page is gone
    const onEscape = (ev: KeyboardEvent) => {
      if (!stage.isConnected) return document.removeEventListener('keydown', onEscape);
      if (ev.key !== 'Escape' || !stage.classList.contains('has-drawer') || ev.defaultPrevented) return;
      if ((ev.target as Element | null)?.closest?.('dialog, .modal, details[open]') || document.querySelector('dialog[open], .modal')) return;
      ev.preventDefault();
      closeDrawer();
    };
    document.addEventListener('keydown', onEscape);

    const draw = (fromSearch = false) => {
      const q = search.value.trim().toLowerCase();
      const hits = d.employees.filter((e) => forest.members.has(e.id) && matches(e, q)).map((e) => e.id);
      // a search opens every collapsed ancestor of a match so the result is visible
      if (fromSearch) for (const id of hits) for (const a of forestAncestors(forest, id)) collapsed.delete(a);
      const hitSet = new Set(hits);
      searchCount.textContent = q ? (hits.length ? `พบ ${hits.length} คน` : 'ไม่พบ') : '';

      const multi = !d.company && companyOrder.length > 1;
      const lay = layoutOrg({
        forest,
        levelOf: (id) => levelInfo(id).level,
        groupOf: (id) => byId.get(id)?.company_id ?? 0,
        groups: companyOrder.map((cid) => ({ key: cid, label: multi ? `${companyName(cid)} · ${d.employees.filter((e) => e.company_id === cid && forest.members.has(e.id)).length} คน` : null })),
        managerOf: (id) => byId.get(id)?.manager_id ?? null,
        collapsed,
        // teams of one manager stay grouped by department (master order), then by the API order
        orderOf: (id) => {
          const dep = byId.get(id)?.department_id ?? null;
          return dep === null ? 1e9 : deptRank.get(dep) ?? 1e8;
        },
      });
      bands = lay.bands;
      const edges = lay.edges.map((ed) => svg('path', {
        class: `org-edge${ed.context ? ' is-context' : ''}`, 'data-from': ed.from, 'data-to': ed.to,
        d: ed.points.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' '),
        fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.5, ...(ed.context ? { 'stroke-dasharray': '5 4' } : {}),
      }));
      // level bands, company frames, external-manager frames, "no reporting line" blocks (behind the cards and lines)
      const frames: SVGElement[] = [];
      const bx = lay.bounds.x - BAND_LABEL_W;
      const bw = lay.bounds.w + BAND_LABEL_W;
      lay.bands.forEach((b, i) => {
        const top = b.y - GAP_Y / 2;
        const next = lay.bands[i + 1];
        const hgt = next ? next.y - b.y : Math.max(lay.bounds.y + lay.bounds.h - top, CARD_H + GAP_Y);
        frames.push(svg('rect', { class: `org-band${i % 2 ? ' is-alt' : ''}`, 'data-level': b.level, x: bx, y: top, width: bw, height: hgt, fill: i % 2 ? '#f1f5f9' : 'transparent' }));
      });
      // in exports (the live chart shows the rail instead)
      for (const b of lay.bands) {
        frames.push(svg('text', { class: 'org-band-label', 'data-level': b.level, 'data-y': b.y, x: bx + 10, y: b.y + H / 2 + 4, 'font-size': 12, 'font-weight': 700, fill: '#64748b' }, `L${b.level} · ${ORG_LEVEL_LABELS[b.level]}`));
      }
      for (const g of lay.groups) {
        if (!g.label) continue;
        frames.push(svg('g', { class: 'org-group', 'data-company': g.key },
          svg('rect', { class: 'org-group-frame', x: g.x, y: g.y, width: g.w, height: g.h, rx: 14, fill: 'none', stroke: '#cbd5e1', 'stroke-width': 1.5 }),
          svg('text', { class: 'org-group-title', x: g.x + 16, y: g.y + 27, 'font-size': 16, 'font-weight': 700, fill: '#0f172a' }, g.label)));
      }
      for (const b of lay.orphans) {
        frames.push(svg('g', { class: 'org-orphans', 'data-company': b.key },
          svg('rect', { class: 'org-orphans-frame', x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, fill: '#f8fafc', stroke: '#94a3b8', 'stroke-width': 1.2, 'stroke-dasharray': '6 4' }),
          svg('text', { class: 'org-orphans-title', x: b.x + FRAME_PAD, y: b.y + FRAME_PAD + 4, 'font-size': 12.5, 'font-weight': 700, fill: '#475569' }, `ไม่มีสายบังคับบัญชา · ${b.ids.length} คน`)));
      }
      // people whose manager is outside this company / chart: the real manager is named, no line is drawn to it
      for (const b of lay.externals) {
        const m = byId.get(b.manager);
        const title = m ? `รายงานต่อ ${m.name} · ${d.companies.find((c) => c.id === m.company_id)?.code ?? companyName(m.company_id)}` : 'หัวหน้าอยู่ต่างบริษัท / นอกผังนี้';
        frames.push(svg('g', { class: 'org-external', 'data-company': b.key, 'data-manager': b.manager },
          svg('rect', { class: 'org-external-frame', x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.2, 'stroke-dasharray': '3 4' }),
          svg('text', { class: 'org-external-title', x: b.x + FRAME_PAD, y: b.y + FRAME_PAD + 4, 'font-size': 12, 'font-weight': 700, fill: '#475569' }, clip(title, Math.max(18, Math.floor((b.w - 2 * FRAME_PAD) / 6.6))), svg('title', {}, title))));
      }
      const nodes: SVGElement[] = [];
      nodeAt.clear();
      for (const [id, at] of lay.nodes) {
        const e = byId.get(id);
        const node = forest.nodes.get(id);
        if (!e || !node) continue;
        const { x, y } = at;
        const lv = levelInfo(id);
        const p = pos(e.position_id);
        const hit = hitSet.has(id);
        const mark = hit || selected === id;
        nodeAt.set(id, { x, y, orphan: at.orphan });
        const dname = e.department_id === null ? 'ไม่ระบุหน่วยงาน' : d.departments.some((x) => x.id === e.department_id) ? deptName(e.department_id) : 'หน่วยงานนอกขอบเขต';
        const third = node.context ? `หัวหน้าจากหน่วยงานอื่น · ${dname}` : dname;
        const color = colorOf(e.department_id);
        const label = `${e.name} ${p?.title ?? ''} · ${dname} · ${levelText(lv)}${node.context ? ' (หัวหน้าจากหน่วยงานอื่น)' : ''}${node.cycle ? ' (สายบังคับบัญชาวนลูป)' : ''}${at.orphan ? ' (ไม่มีสายบังคับบัญชา)' : ''}${at.external !== null ? ' (หัวหน้าอยู่ต่างบริษัท)' : ''}`;
        const g = svg('g', {
          class: `org-node${node.context ? ' is-context' : ''}${node.cycle ? ' is-cycle' : ''}${hit ? ' is-hit' : ''}${selected === id ? ' is-selected' : ''}${lv.mapped ? '' : ' is-unmapped'}`,
          'data-id': id, 'data-level': lv.level, 'data-dept': e.department_id ?? 'none', 'data-color': color, ...(at.orphan ? { 'data-orphan': 1 } : {}), ...(at.external !== null ? { 'data-external': at.external } : {}), ...(at.grid ? { 'data-grid-row': at.grid.gridRow } : {}), transform: `translate(${x},${y})`, tabindex: 0, role: 'button', 'aria-label': label,
          ...(node.children.length ? { 'aria-expanded': String(!collapsed.has(id)) } : {}),
        },
          // highlight ring (search hit / selected / keyboard focus / loop) outside the card, so the border keeps its colour
          svg('rect', { class: 'org-ring', x: -5, y: -5, width: W + 10, height: H + 10, rx: 12, fill: 'none', stroke: mark ? '#f59e0b' : node.cycle ? '#dc2626' : 'transparent', 'stroke-width': mark ? 3 : 2, ...(node.cycle && !mark ? { 'stroke-dasharray': '4 3' } : {}) }),
          svg('rect', { class: 'org-card', width: W, height: H, rx: 8, fill: node.context ? '#f8fafc' : '#ffffff', stroke: color, 'stroke-width': 2, ...(node.context ? { 'stroke-dasharray': '5 4' } : {}) }),
          avatarNode(e, node.context),
          svg('text', { class: 'org-t1', x: TX, y: 20, 'font-size': 13, 'font-weight': 700, fill: node.context ? '#475569' : '#0f172a' }, clip(e.name, node.cycle ? 13 : 19)),
          svg('text', { class: 'org-t2', x: TX, y: 38, 'font-size': 11.5, fill: '#334155' }, clip(p?.title ?? 'ไม่ระบุตำแหน่ง', 22)),
          svg('text', { class: 'org-t3', x: TX, y: 55, 'font-size': 10.5, 'font-weight': 600, fill: '#475569' }, clip(third, 25)),
          svg('title', {}, `${e.name}\n${p?.title ?? 'ไม่ระบุตำแหน่ง'}\n${third}`));
        if (node.cycle) g.append(svg('g', { class: 'org-cycle-badge', transform: `translate(${W - 58},6)` }, svg('rect', { width: 52, height: 17, rx: 8.5, fill: '#fee2e2', stroke: '#dc2626' }), svg('text', { x: 26, y: 12.5, 'font-size': 10, 'text-anchor': 'middle', fill: '#b91c1c' }, 'วนลูป')));
        // unmapped title: a tab on the card's top edge (clear of the name and of the connector at the top centre)
        if (!lv.mapped) g.append(svg('g', { class: 'org-unmapped-badge', transform: `translate(${W - 96},-9)` }, svg('rect', { width: 90, height: 17, rx: 8.5, fill: '#fef3c7', stroke: '#d97706' }), svg('text', { x: 45, y: 12.5, 'font-size': 10, 'font-weight': 700, 'text-anchor': 'middle', fill: '#92400e' }, 'Unmapped Level')));
        if (node.children.length) {
          const closed = collapsed.has(id);
          g.append(svg('g', { class: 'org-toggle', transform: `translate(${W / 2 - 13},${H - 13})`, 'data-toggle': id },
            svg('circle', { cx: 13, cy: 13, r: 18, fill: 'transparent' }),
            svg('circle', { class: 'org-toggle-dot', cx: 13, cy: 13, r: 12, fill: closed ? '#2563eb' : '#f1f5f9', stroke: closed ? '#1d4ed8' : '#94a3b8' }),
            svg('text', { class: 'org-toggle-text', x: 13, y: 17, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle', fill: closed ? '#ffffff' : '#0f172a' }, closed ? `+${node.children.length}` : '−')));
        }
        nodes.push(g);
      }
      content = { ...lay.bounds };
      exportBox = { x: lay.bounds.x - BAND_LABEL_W, y: lay.bounds.y, w: lay.bounds.w + BAND_LABEL_W, h: lay.bounds.h };
      drawLegend(lay);
      mount(levelRail, lay.nodes.size ? lay.bands.map((b) => h('span', { class: 'org-level-pill', 'data-level': String(b.level), title: `L${b.level} · ${ORG_LEVEL_LABELS[b.level]}` },
        h('b', null, `L${b.level}`), h('span', { class: 'org-level-name' }, ORG_LEVEL_LABELS[b.level]))) : null);
      levelRail.hidden = !lay.nodes.size;
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      current = svg('svg', { xmlns: SVG_NS, width: '100%', height: '100%', preserveAspectRatio: 'xMinYMin meet', 'font-family': font, role: 'img', 'aria-label': 'ผังสายบังคับบัญชา' },
        svg('defs', {}, svg('clipPath', { id: 'org-avatar-clip', clipPathUnits: 'objectBoundingBox' }, svg('circle', { cx: 0.5, cy: 0.5, r: 0.5 }))),
        svg('g', { class: 'org-frames' }, ...frames), svg('g', {}, ...edges), svg('g', {}, ...nodes));
      mount(chartBox, forest.roots.length ? current : h('div', { class: 'empty' }, dept ? 'ไม่มีพนักงานในหน่วยงานนี้' : 'ไม่มีพนักงานในขอบเขตนี้'));
      apply();
      const unmapped = d.employees.filter((e) => forest.members.has(e.id) && !levelInfo(e.id).mapped);
      const titles = [...new Set(unmapped.map((e) => pos(e.position_id)?.title ?? 'ไม่ระบุตำแหน่ง'))];
      unmappedNote.textContent = unmapped.length
        ? `Unmapped Level: ${unmapped.length} คน ตำแหน่งยังไม่อยู่ใน Mapping ระดับ (${titles.slice(0, 6).join(', ')}${titles.length > 6 ? ` และอีก ${titles.length - 6} ตำแหน่ง` : ''}) — แสดงเป็น L5 ชั่วคราว ให้ HR ตรวจสอบ`
        : '';
      unmappedNote.hidden = !unmapped.length;
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
      forest = buildForest();
      collapsed.clear();
      // the detail panel reflects the new filter (e.g. "manager from another department" only applies inside it)
      const still = selected !== null && forest.nodes.has(selected) ? byId.get(selected) : undefined;
      if (still) showDetail(still);
      else {
        selected = null;
        mount(side, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
        stage.classList.remove('has-drawer');
      }
      if (view === 'table') return redrawTable();
      draw(true);
      if (!search.value.trim()) readableFit();
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
      if (ev.key === 'Escape' && stage.classList.contains('has-drawer')) {
        ev.preventDefault();
        closeDrawer();
        return;
      }
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
        '+': () => zoomCentre(1.25), '=': () => zoomCentre(1.25), '-': () => zoomCentre(1 / 1.25), '0': resetView, f: fit, r: readableFit,
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
      clone.setAttribute('viewBox', `${exportBox.x} ${exportBox.y} ${exportBox.w} ${exportBox.h}`);
      clone.setAttribute('width', String(exportBox.w));
      clone.setAttribute('height', String(exportBox.h));
      clone.removeAttribute('data-scale');
      clone.insertBefore(svg('rect', { x: exportBox.x, y: exportBox.y, width: exportBox.w, height: exportBox.h, fill: '#ffffff' }), clone.firstChild);
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
        const k = Math.min(2, 16000 / Math.max(exportBox.w, exportBox.h));
        canvas.width = Math.round(exportBox.w * k);
        canvas.height = Math.round(exportBox.h * k);
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
      if (current) current.setAttribute('viewBox', `${exportBox.x} ${exportBox.y} ${exportBox.w} ${exportBox.h}`);
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
        h('thead', null, h('tr', null, ['รหัส', 'ชื่อ-นามสกุล', 'หน่วยงาน', 'ตำแหน่ง', 'Grade', 'ระดับในผัง', 'หัวหน้า', 'ผู้ใต้บังคับบัญชา'].map((t) => h('th', null, t)))),
        h('tbody', null, d.employees.filter((e) => include(e) && (!search.value.trim() || matches(e, search.value.trim().toLowerCase()))).map((e) => {
          const m = e.manager_id ? byId.get(e.manager_id) : undefined;
          return h('tr', null, h('td', null, e.emp_code), h('td', null, e.name), h('td', null, deptName(e.department_id)), h('td', null, pos(e.position_id)?.title ?? '-'), h('td', null, pos(e.position_id)?.job_grade ?? '-'),
            h('td', null, levelInfo(e.id).mapped ? levelText(levelInfo(e.id)) : h('span', { class: 'badge-status s-pending' }, levelText(levelInfo(e.id)))),
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
      chips, filterNote, unmappedNote,
      h('div', { class: 'kpis' }, kpi('พนักงาน', s.employees), kpi('หน่วยงาน', s.departments), kpi('ระดับชั้นการบังคับบัญชา', s.levels), kpi('ตำแหน่งที่มีคนครอง', `${s.occupiedPositions} / ${s.positions}`),
        kpi('อัตราอนุมัติ (Approved)', s.approved), kpi('มีคนครอง (Occupied)', s.occupied), kpi('ว่าง (Vacant)', s.vacant, s.vacant ? 'kpi-warn' : ''), kpi('เกินอัตรา (Over)', s.over, s.over ? 'kpi-bad' : '')),
      view === 'chart' ? legend : null,
      view === 'chart' ? h('div', { class: 'org-layout' }, stage) : tableBox);
    if (view === 'chart') {
      draw();
      // the chart opens readable (Readable Fit); Whole Chart Fit stays one click away
      requestAnimationFrame(() => readableFit());
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
