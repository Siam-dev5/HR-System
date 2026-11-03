// Organization Design: interactive reporting-line chart (SVG) and table view over the real master data.
// Search, department filter, zoom / fit, expand / collapse, employee detail, edit reports-to, validated import,
// Excel / CSV (server) and PNG / SVG / PDF (client) export. No sample data, no offline storage.
import type { OrgDesignResponse, OrgEmployeeNode } from '../../shared/types';
import { get, post, api, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, link, state } from '../app';
import { noCompanies, readGridFile } from './attendance';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 210;
const H = 66;
const GX = 18;
const GY = 46;
const PALETTE = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#0d9488'];

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: Array<SVGElement | string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
    const kidsOf = (id: number, set: Set<number>) => d.employees.filter((e) => e.manager_id === id && set.has(e.id));

    const companySel = h('select', { 'aria-label': 'บริษัท', onchange: () => go({ company: companySel.value }) },
      state.meta?.companies.scope === 'all' ? h('option', { value: '', selected: !d.company }, 'ทุกบริษัท') : null,
      d.companies.map((c) => h('option', { value: String(c.id), selected: c.id === d.company?.id }, c.name)));
    const deptSel = h('select', { 'aria-label': 'หน่วยงาน', onchange: () => draw() }, h('option', { value: '' }, 'ทุกหน่วยงาน'),
      d.departments.map((x) => h('option', { value: String(x.id) }, `${'— '.repeat(Math.max(0, x.level - 1))}${x.name}`)));
    const search = h('input', { type: 'search', placeholder: 'ค้นหาชื่อ / รหัส / ตำแหน่ง', 'aria-label': 'ค้นหาพนักงาน', oninput: () => draw(true) });
    const chartBox = h('div', { class: 'org-canvas', tabindex: '0', 'aria-label': 'ผังองค์กร' });
    const side = h('aside', { class: 'card org-side', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'เลือกพนักงานในผังเพื่อดูรายละเอียด'));
    const collapsed = new Set<number>();
    let scale = 1;
    let current: SVGSVGElement | null = null;
    let selected: number | null = null;

    const filtered = (): Set<number> => {
      const dep = deptSel.value ? Number(deptSel.value) : null;
      return new Set(d.employees.filter((e) => dep === null || e.department_id === dep).map((e) => e.id));
    };
    const matches = (e: OrgEmployeeNode, q: string) => !!q && `${e.emp_code} ${e.name} ${pos(e.position_id)?.title ?? ''}`.toLowerCase().includes(q);

    const showDetail = (e: OrgEmployeeNode) => {
      selected = e.id;
      const p = pos(e.position_id);
      const mgr = e.manager_id ? byId.get(e.manager_id) : undefined;
      const reports = d.employees.filter((x) => x.manager_id === e.id);
      const pick = (x: OrgEmployeeNode) => h('button', { class: 'as-link', onclick: () => { showDetail(x); focusNode(x.id); } }, `${x.emp_code} ${x.name}`);
      mount(side,
        h('h3', null, e.name), h('div', { class: 'muted' }, e.emp_code),
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

    const focusNode = (id: number) => {
      const el = chartBox.querySelector(`[data-id="${id}"]`) as SVGGElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const b = chartBox.getBoundingClientRect();
      chartBox.scrollBy({ left: r.left - b.left - b.width / 2 + r.width / 2, top: r.top - b.top - b.height / 2 + r.height / 2, behavior: 'smooth' });
    };

    const draw = (fromSearch = false) => {
      const set = filtered();
      const q = search.value.trim().toLowerCase();
      if (fromSearch && q) {
        // expand every ancestor of a match so the result is visible
        for (const e of d.employees) {
          if (!set.has(e.id) || !matches(e, q)) continue;
          let m = e.manager_id;
          const seen = new Set<number>();
          while (m !== null && !seen.has(m)) {
            seen.add(m);
            collapsed.delete(m);
            m = byId.get(m)?.manager_id ?? null;
          }
        }
      }
      const roots = d.employees.filter((e) => set.has(e.id) && !(e.manager_id !== null && set.has(e.manager_id)));
      const widthOf = new Map<number, number>();
      const visiting = new Set<number>();
      const measure = (e: OrgEmployeeNode): number => {
        if (visiting.has(e.id)) return W;
        visiting.add(e.id);
        const kids = collapsed.has(e.id) ? [] : kidsOf(e.id, set);
        const w = kids.length ? Math.max(W, kids.reduce((a, k) => a + measure(k), 0) + GX * (kids.length - 1)) : W;
        widthOf.set(e.id, w);
        return w;
      };
      const totalW = Math.max(W, roots.reduce((a, r) => a + measure(r), 0) + GX * Math.max(0, roots.length - 1));
      const nodes: SVGElement[] = [];
      const edges: SVGElement[] = [];
      let maxDepth = 0;
      const placed = new Set<number>();
      const place = (e: OrgEmployeeNode, x0: number, depth: number) => {
        if (placed.has(e.id)) return;
        placed.add(e.id);
        maxDepth = Math.max(maxDepth, depth);
        const w = widthOf.get(e.id) ?? W;
        const cx = x0 + w / 2;
        const y = depth * (H + GY) + 10;
        const allKids = kidsOf(e.id, set);
        const kids = collapsed.has(e.id) ? [] : allKids;
        let kx = x0 + (w - (kids.reduce((a, k) => a + (widthOf.get(k.id) ?? W), 0) + GX * Math.max(0, kids.length - 1))) / 2;
        for (const k of kids) {
          const kw = widthOf.get(k.id) ?? W;
          const kcx = kx + kw / 2;
          const ky = (depth + 1) * (H + GY) + 10;
          edges.push(svg('path', { d: `M${cx},${y + H} V${y + H + GY / 2} H${kcx} V${ky}`, fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.5 }));
          place(k, kx, depth + 1);
          kx += kw + GX;
        }
        const p = pos(e.position_id);
        const hit = matches(e, q);
        const g = svg('g', { class: 'org-node', 'data-id': e.id, transform: `translate(${cx - W / 2},${y})`, tabindex: 0, role: 'button', 'aria-label': `${e.name} ${p?.title ?? ''}` },
          svg('rect', { width: W, height: H, rx: 8, fill: '#ffffff', stroke: hit || selected === e.id ? '#f59e0b' : '#cbd5e1', 'stroke-width': hit || selected === e.id ? 3 : 1 }),
          svg('rect', { width: 6, height: H, rx: 3, fill: colorOf(e.department_id) }),
          svg('text', { x: 14, y: 20, 'font-size': 13, 'font-weight': 700, fill: '#0f172a' }, clip(e.name, 26)),
          svg('text', { x: 14, y: 38, 'font-size': 11.5, fill: '#334155' }, clip(p?.title ?? 'ไม่ระบุตำแหน่ง', 30)),
          svg('text', { x: 14, y: 55, 'font-size': 10.5, fill: '#64748b' }, clip(`${e.emp_code} · ${deptName(e.department_id)}`, 34)));
        if (allKids.length) {
          const t = svg('g', { class: 'org-toggle', transform: `translate(${W / 2 - 11},${H - 11})`, 'data-toggle': e.id },
            svg('circle', { cx: 11, cy: 11, r: 10, fill: '#f1f5f9', stroke: '#94a3b8' }),
            svg('text', { x: 11, y: 15, 'font-size': 11, 'text-anchor': 'middle', fill: '#0f172a' }, collapsed.has(e.id) ? `+${allKids.length}` : '−'));
          g.append(t);
        }
        nodes.push(g);
      };
      let x = 0;
      for (const r of roots) {
        place(r, x, 0);
        x += (widthOf.get(r.id) ?? W) + GX;
      }
      const totalH = (maxDepth + 1) * (H + GY) + 10;
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      current = svg('svg', { xmlns: SVG_NS, viewBox: `-10 0 ${totalW + 20} ${totalH}`, width: Math.round((totalW + 20) * scale), height: Math.round(totalH * scale), 'font-family': font, role: 'img', 'aria-label': 'ผังสายบังคับบัญชา' },
        svg('g', {}, ...edges), svg('g', {}, ...nodes));
      mount(chartBox, roots.length ? current : h('div', { class: 'empty' }, 'ไม่มีพนักงานในขอบเขตนี้'));
      if (fromSearch && q) {
        const first = d.employees.find((e) => set.has(e.id) && matches(e, q));
        if (first) focusNode(first.id);
      }
    };
    chartBox.addEventListener('click', (ev) => {
      const t = (ev.target as Element).closest('[data-toggle]');
      if (t) {
        const id = Number(t.getAttribute('data-toggle'));
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        return draw();
      }
      const n = (ev.target as Element).closest('[data-id]');
      if (n) {
        const e = byId.get(Number(n.getAttribute('data-id')));
        if (e) {
          showDetail(e);
          draw();
        }
      }
    });
    chartBox.addEventListener('keydown', (ev) => {
      const n = (ev.target as Element).closest?.('[data-id]');
      if (n && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        const e = byId.get(Number(n.getAttribute('data-id')));
        if (e) showDetail(e);
      }
    });
    const zoom = (f: number | 'fit') => {
      if (!current) return;
      const vb = current.viewBox.baseVal;
      scale = f === 'fit' ? Math.max(0.2, Math.min(1.5, (chartBox.clientWidth - 16) / vb.width)) : Math.max(0.2, Math.min(2.5, scale * f));
      current.setAttribute('width', String(Math.round(vb.width * scale)));
      current.setAttribute('height', String(Math.round(vb.height * scale)));
    };

    const exportSvgText = (): string | null => {
      if (!current) return null;
      const clone = current.cloneNode(true) as SVGSVGElement;
      const vb = current.viewBox.baseVal;
      clone.setAttribute('width', String(vb.width));
      clone.setAttribute('height', String(vb.height));
      clone.insertBefore(svg('rect', { x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: '#ffffff' }), clone.firstChild);
      return new XMLSerializer().serializeToString(clone);
    };
    const fileBase = `organization${d.company ? `-${d.company.code}` : ''}`;
    const exportPng = () => {
      const text = exportSvgText();
      if (!text || !current) return;
      const vb = current.viewBox.baseVal;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const k = Math.min(2, 16000 / Math.max(vb.width, vb.height));
        canvas.width = Math.round(vb.width * k);
        canvas.height = Math.round(vb.height * k);
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
      zoom('fit');
      document.body.classList.add('print-org');
      const done = () => {
        document.body.classList.remove('print-org');
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      window.print();
    };
    const exportMenu = h('details', { class: 'menu-details', ontoggle: (e: Event) => {
      const el = e.currentTarget as HTMLDetailsElement;
      if (!el.open) return;
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
          h('button', { class: 'menu-link', onclick: () => { const t = exportSvgText(); if (t) download(`${fileBase}.svg`, new Blob([t], { type: 'image/svg+xml' })); } }, 'SVG'),
          h('button', { class: 'menu-link', onclick: exportPdf }, 'PDF (พิมพ์)'),
        ] : null));

    const s = d.stats;
    const kpi = (label: string, value: string | number, cls = '') => h('div', { class: `card kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)));
    const tableView = () => h('div', { class: 'stack' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['รหัส', 'ชื่อ-นามสกุล', 'หน่วยงาน', 'ตำแหน่ง', 'Grade', 'หัวหน้า', 'ผู้ใต้บังคับบัญชา'].map((t) => h('th', null, t)))),
        h('tbody', null, d.employees.filter((e) => filtered().has(e.id) && (!search.value.trim() || matches(e, search.value.trim().toLowerCase()))).map((e) => {
          const m = e.manager_id ? byId.get(e.manager_id) : undefined;
          return h('tr', null, h('td', null, e.emp_code), h('td', null, e.name), h('td', null, deptName(e.department_id)), h('td', null, pos(e.position_id)?.title ?? '-'), h('td', null, pos(e.position_id)?.job_grade ?? '-'),
            h('td', null, m ? `${m.emp_code} ${m.name}` : '-'), h('td', { class: 'num' }, String(d.employees.filter((x) => x.manager_id === e.id).length)));
        })))),
      h('h3', null, 'อัตรากำลังตามตำแหน่ง (Approved / Occupied / Vacant)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['รหัส', 'ตำแหน่ง', 'หน่วยงาน', 'Grade', 'อัตราอนุมัติ', 'มีคนครอง', 'ว่าง (Vacant)', 'เกินอัตรา (Over)'].map((t) => h('th', null, t)))),
        h('tbody', null, d.positions.filter((p) => !deptSel.value || p.department_id === Number(deptSel.value)).map((p) => h('tr', null,
          h('td', null, p.code), h('td', null, p.title), h('td', null, deptName(p.department_id)), h('td', null, p.job_grade ?? '-'),
          h('td', { class: 'num' }, String(p.approved)), h('td', { class: 'num' }, String(p.occupied)),
          h('td', { class: 'num' }, p.vacant ? h('span', { class: 'badge-status s-pending' }, String(p.vacant)) : '0'),
          h('td', { class: 'num' }, p.over ? h('span', { class: 'badge-status s-rejected' }, `+${p.over}`) : '0')))))));

    const tableBox = h('div');
    const redrawTable = () => mount(tableBox, tableView());
    if (view === 'table') {
      deptSel.onchange = redrawTable;
      search.oninput = redrawTable;
    }

    mount(main,
      h('div', { class: 'toolbar org-toolbar' },
        d.companies.length ? h('label', { class: 'field inline' }, h('span', null, 'บริษัท'), companySel) : null,
        h('label', { class: 'field inline' }, h('span', null, 'หน่วยงาน'), deptSel), search,
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'มุมมอง' },
          h('button', { class: `btn small ${view === 'chart' ? 'primary' : ''}`, 'aria-pressed': view === 'chart' ? 'true' : 'false', onclick: () => go({ view: 'chart' }) }, 'ผังองค์กร'),
          h('button', { class: `btn small ${view === 'table' ? 'primary' : ''}`, 'aria-pressed': view === 'table' ? 'true' : 'false', onclick: () => go({ view: 'table' }) }, 'ตาราง')),
        h('div', { class: 'spacer' }),
        view === 'chart' ? [
          h('button', { class: 'btn small', 'aria-label': 'ซูมออก', onclick: () => zoom(1 / 1.2) }, '−'),
          h('button', { class: 'btn small', 'aria-label': 'ซูมเข้า', onclick: () => zoom(1.2) }, '+'),
          h('button', { class: 'btn small', onclick: () => zoom('fit') }, 'พอดีจอ'),
          h('button', { class: 'btn small', onclick: () => { collapsed.clear(); draw(); } }, 'ขยายทั้งหมด'),
          h('button', { class: 'btn small', onclick: () => { for (const e of d.employees) if (d.employees.some((x) => x.manager_id === e.id)) collapsed.add(e.id); draw(); } }, 'ย่อทั้งหมด'),
        ] : null,
        d.canExport ? exportMenu : null,
        d.canImport ? h('button', { class: 'btn small', onclick: () => importDialog(d, () => void renderOrgChart(main, params)) }, 'Import') : null,
        can('employees.create') ? link('/employees', '+ เพิ่มพนักงาน', { class: 'btn small' }) : null),
      h('div', { class: 'kpis' }, kpi('พนักงาน', s.employees), kpi('หน่วยงาน', s.departments), kpi('ระดับชั้นการบังคับบัญชา', s.levels), kpi('ตำแหน่งที่มีคนครอง', `${s.occupiedPositions} / ${s.positions}`),
        kpi('อัตราอนุมัติ (Approved)', s.approved), kpi('มีคนครอง (Occupied)', s.occupied), kpi('ว่าง (Vacant)', s.vacant, s.vacant ? 'kpi-warn' : ''), kpi('เกินอัตรา (Over)', s.over, s.over ? 'kpi-bad' : '')),
      view === 'chart' ? h('div', { class: 'org-layout' }, chartBox, side) : tableBox);
    if (view === 'chart') {
      draw();
      requestAnimationFrame(() => zoom('fit'));
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
