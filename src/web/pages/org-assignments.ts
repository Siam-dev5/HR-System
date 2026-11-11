// Cross Company Manager Assignment (/org-chart/assignments): HR assigns a person as the responsible manager of a
// department / team of another company (optionally for one named employee), with dates, type and responsibility.
// List with search / filters / detail, create, edit, pause (inactive) / re-activate, cancel with a reason, and the
// change history. The server enforces every rule and the company scope (hidden buttons are convenience only). The
// primary reporting line (Reports To / manager_id) is never changed here; the organization chart shows the result
// right away as a dashed line and a reference card in the target team.
import { ASSIGNMENT_TYPE_LABEL, type AssignmentState, type AssignmentType } from '../../shared/cross-company';
import { get, post, put, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, modal, toast, promptDialog } from '../dom';
import { link } from '../app';

interface Company { id: number; code: string; name: string }
interface Department { id: number; code: string; name: string; company_id: number }
interface Meta { today: string; companies: Company[]; departments: Department[]; types: Array<{ value: AssignmentType; label: string }>; states: Array<{ value: AssignmentState; label: string }>; canManage: boolean }
interface Person { id: number; emp_code: string; name: string; company_id: number; company_code: string; company_name: string; department_id: number | null; department_name: string | null; position_title: string | null }
interface Item {
  id: number;
  manager_employee_id: number;
  manager_code: string | null;
  manager_name: string | null;
  manager_masked: boolean;
  manager_live_company: number;
  manager_company_code: string;
  manager_company_name: string;
  manager_department_name: string | null;
  manager_position: string | null;
  target_company_id: number;
  target_company_code: string;
  target_company_name: string;
  target_department_id: number;
  target_department_name: string;
  team_name: string | null;
  employee_id: number | null;
  employee_code: string | null;
  employee_name: string | null;
  employee_masked: boolean;
  employee_company_code: string | null;
  employee_department_name: string | null;
  relationship_type: AssignmentType;
  type_label: string;
  responsibility: string | null;
  effective_from: string;
  effective_to: string | null;
  status: 'active' | 'inactive' | 'cancelled';
  state: AssignmentState;
  state_label: string;
  cancel_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  can_manage: boolean;
}
interface HistoryItem { id: number; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null; at: string; by_name: string | null }
interface History { items: HistoryItem[]; names: { employees: Record<string, string>; departments: Record<string, string>; companies: Record<string, string> } }

const STATE_CLASS: Record<AssignmentState, string> = { active: 's-ok', scheduled: 's-pending', expired: 's-superseded', inactive: 's-superseded', cancelled: 's-error' };
const ACTION_LABEL: Record<string, string> = { created: 'สร้าง', updated: 'แก้ไข', activated: 'เปิดใช้งาน', deactivated: 'ระงับชั่วคราว', cancelled: 'ยกเลิก' };
const FIELD_LABEL: Record<string, string> = {
  manager_employee_id: 'ผู้รับผิดชอบ', manager_company_id: 'บริษัทของผู้รับผิดชอบ', target_company_id: 'บริษัทปลายทาง', target_department_id: 'หน่วยงานปลายทาง', team_name: 'ชื่อทีม',
  employee_id: 'พนักงานที่ดูแล', employee_company_id: 'บริษัทของพนักงาน', relationship_type: 'ประเภทความสัมพันธ์', responsibility: 'รายละเอียดหน้าที่', effective_from: 'เริ่มมีผล', effective_to: 'สิ้นสุด', status: 'สถานะ',
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const personOf = (code: string | null, name: string | null, masked: boolean, company: string | null) => (masked ? `ผู้รับผิดชอบจากต่างบริษัท (${company ?? '-'})` : `${code ?? ''} ${name ?? ''}`.trim());
const teamOf = (x: Pick<Item, 'target_department_name' | 'team_name'>) => `${x.target_department_name}${x.team_name ? ` / ${x.team_name}` : ''}`;
const periodOf = (x: Pick<Item, 'effective_from' | 'effective_to'>) => `${fmtDate(x.effective_from)} – ${x.effective_to ? fmtDate(x.effective_to) : 'ไม่กำหนด'}`;
/** the one-sentence meaning of an assignment (shown in the form, the confirmation and the detail) */
const sentence = (x: { manager: string; managerCompany: string; type: string; team: string; targetCompany: string; employee: string | null; from: string; to: string | null }) =>
  `${x.manager} (${x.managerCompany}) เป็น${x.type} ของ ${x.team} บริษัท ${x.targetCompany}${x.employee ? ` โดยดูแล ${x.employee}` : ' (ทั้งทีม)'} ตั้งแต่ ${fmtDate(x.from)}${x.to ? ` ถึง ${fmtDate(x.to)}` : ' (ไม่กำหนดวันสิ้นสุด)'}`;
const itemSentence = (x: Item) => sentence({
  manager: personOf(x.manager_code, x.manager_name, x.manager_masked, x.manager_company_code), managerCompany: x.manager_company_code, type: ASSIGNMENT_TYPE_LABEL[x.relationship_type],
  team: teamOf(x), targetCompany: x.target_company_code, employee: x.employee_id === null ? null : personOf(x.employee_code, x.employee_name, x.employee_masked, x.employee_company_code), from: x.effective_from, to: x.effective_to,
});

export async function renderOrgAssignments(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const meta = await get<Meta>('/api/org-assignments/meta');
    const q = h('input', { type: 'search', name: 'q', placeholder: 'ค้นหา รหัส / ชื่อ / ทีม / บริษัท', 'aria-label': 'ค้นหาความสัมพันธ์', value: params.get('q') ?? '' });
    const stateSel = h('select', { name: 'state', 'aria-label': 'สถานะ' }, h('option', { value: '' }, 'ทุกสถานะ'), meta.states.map((s) => h('option', { value: s.value, selected: params.get('state') === s.value }, s.label)));
    const typeSel = h('select', { name: 'type', 'aria-label': 'ประเภทความสัมพันธ์' }, h('option', { value: '' }, 'ทุกประเภท'), meta.types.map((t) => h('option', { value: t.value }, t.label)));
    const coSel = h('select', { name: 'company', 'aria-label': 'บริษัทที่เกี่ยวข้อง' }, h('option', { value: '' }, 'ทุกบริษัท'), meta.companies.map((c) => h('option', { value: String(c.id) }, `${c.code} · ${c.name}`)));
    const out = h('div', { class: 'stack' }, loading());
    const count = h('span', { class: 'muted', 'aria-live': 'polite' });

    const load = async () => {
      try {
        const r = await get<{ today: string; items: Item[] }>(`/api/org-assignments${qs({ q: q.value.trim() || null, state: stateSel.value || null, type: typeSel.value || null, company: coSel.value || null })}`);
        count.textContent = `${r.items.length} รายการ`;
        mount(out, r.items.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact cca-table' },
          h('thead', null, h('tr', null, ['Employee Code', 'Employee Name', 'Primary Company', 'Primary Department', 'Assigned Manager', 'Manager Company', 'Target Department / Team', 'Relationship Type', 'Effective Start', 'Effective End', 'Status', 'Updated By', 'Updated At', ''].map((t) => h('th', null, t)))),
          h('tbody', null, r.items.map((x) => h('tr', { 'data-id': x.id, 'data-state': x.state },
            h('td', null, x.employee_id === null ? '—' : x.employee_masked ? '•••' : x.employee_code ?? '-'),
            h('td', null, x.employee_id === null ? h('span', { class: 'muted' }, 'ทั้งทีม') : x.employee_masked ? 'ผู้รับผิดชอบจากต่างบริษัท' : x.employee_name ?? '-'),
            h('td', null, x.employee_id === null ? x.target_company_code : x.employee_company_code ?? '-'),
            h('td', null, x.employee_id === null ? x.target_department_name : x.employee_department_name ?? '-'),
            h('td', null, h('strong', null, personOf(x.manager_code, x.manager_name, x.manager_masked, x.manager_company_code)), x.manager_position ? h('div', { class: 'muted small' }, x.manager_position) : null),
            h('td', null, x.manager_company_code),
            h('td', null, teamOf(x), h('div', { class: 'muted small' }, x.target_company_code)),
            h('td', null, x.type_label),
            h('td', null, fmtDate(x.effective_from)),
            h('td', null, x.effective_to ? fmtDate(x.effective_to) : 'ไม่กำหนด'),
            h('td', null, h('span', { class: `badge-status ${STATE_CLASS[x.state]}` }, x.state_label)),
            h('td', null, x.updated_by_name ?? '-'),
            h('td', null, fmtDate(x.updated_at)),
            h('td', { class: 'actions' },
              h('button', { type: 'button', class: 'btn small', 'data-act': 'detail', onclick: () => void detail(x) }, 'รายละเอียด'),
              x.can_manage && x.status !== 'cancelled' ? [
                h('button', { type: 'button', class: 'btn small', 'data-act': 'edit', onclick: () => editor(x) }, 'แก้ไข'),
                h('button', { type: 'button', class: 'btn small', 'data-act': x.status === 'active' ? 'deactivate' : 'activate', onclick: () => void setStatus(x, x.status === 'active' ? 'inactive' : 'active') }, x.status === 'active' ? 'ระงับ' : 'เปิดใช้'),
                h('button', { type: 'button', class: 'btn small danger', 'data-act': 'cancel', onclick: () => void cancel(x) }, 'ยกเลิก'),
              ] : null)))))) : h('div', { class: 'empty' }, 'ยังไม่มีความสัมพันธ์ข้ามบริษัทตามเงื่อนไขนี้'));
      } catch (e) {
        mount(out, errorBox(e));
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    });
    for (const s of [stateSel, typeSel, coSel]) s.addEventListener('change', () => void load());

    const setStatus = async (x: Item, status: 'active' | 'inactive') => {
      const reason = await promptDialog(status === 'inactive' ? 'ระงับความสัมพันธ์ชั่วคราว' : 'เปิดใช้งานความสัมพันธ์อีกครั้ง', 'เหตุผล (ไม่บังคับ)', status === 'inactive' ? 'ระงับ' : 'เปิดใช้');
      if (reason === null) return;
      try {
        await post(`/api/org-assignments/${x.id}/status`, { status, reason: reason || null });
        toast(status === 'inactive' ? 'ระงับแล้ว — ไม่แสดงในผังองค์กรจนกว่าจะเปิดใช้' : 'เปิดใช้งานแล้ว');
        await load();
      } catch (e) {
        toast(msg(e), 'error');
      }
    };
    const cancel = async (x: Item) => {
      const reason = await promptDialog('ยกเลิกความสัมพันธ์ข้ามบริษัท', `เหตุผลที่ยกเลิก (ประวัติยังถูกเก็บไว้) · ${itemSentence(x)}`, 'ยืนยันยกเลิก');
      if (reason === null) return;
      try {
        await post(`/api/org-assignments/${x.id}/cancel`, { reason });
        toast('ยกเลิกแล้ว — ประวัติยังถูกเก็บไว้');
        await load();
      } catch (e) {
        toast(msg(e), 'error');
      }
    };

    const historyList = (hst: History) => {
      const show = (k: string, v: unknown) => {
        if (v === null || v === undefined || v === '') return '-';
        if (k === 'manager_employee_id' || k === 'employee_id') return hst.names.employees[String(v)] ?? `#${v}`;
        if (k === 'target_department_id') return hst.names.departments[String(v)] ?? `#${v}`;
        if (k.endsWith('company_id')) return hst.names.companies[String(v)] ?? `#${v}`;
        if (k === 'relationship_type') return ASSIGNMENT_TYPE_LABEL[v as AssignmentType] ?? String(v);
        if (k.startsWith('effective_')) return fmtDate(v);
        return String(v);
      };
      return h('ol', { class: 'cca-history' }, hst.items.map((it) => {
        const keys = [...new Set([...Object.keys(it.before ?? {}), ...Object.keys(it.after ?? {})])].filter((k) => JSON.stringify(it.before?.[k] ?? null) !== JSON.stringify(it.after?.[k] ?? null));
        return h('li', { 'data-action': it.action },
          h('div', null, h('strong', null, ACTION_LABEL[it.action] ?? it.action), h('span', { class: 'muted small' }, ` · ${fmtDate(it.at)} · ${it.by_name ?? '-'}`)),
          it.reason ? h('div', { class: 'small' }, `เหตุผล: ${it.reason}`) : null,
          keys.length ? h('ul', { class: 'plain small' }, keys.map((k) => h('li', null, it.before ? `${FIELD_LABEL[k] ?? k}: ${show(k, it.before[k])} → ${show(k, it.after?.[k])}` : `${FIELD_LABEL[k] ?? k}: ${show(k, it.after?.[k])}`))) : null);
      }));
    };
    const detail = async (x: Item) => {
      try {
        const hst = await get<History>(`/api/org-assignments/${x.id}/history`);
        const dlg = modal(`ความสัมพันธ์ข้ามบริษัท #${x.id}`, h('div', { class: 'stack cca-detail' },
          h('p', { class: 'cca-sentence' }, itemSentence(x)),
          h('dl', { class: 'dl' },
            h('dt', null, 'ผู้รับผิดชอบ'), h('dd', null, personOf(x.manager_code, x.manager_name, x.manager_masked, x.manager_company_code)),
            h('dt', null, 'อยู่บริษัท / หน่วยงาน'), h('dd', null, `${x.manager_company_name} (${x.manager_company_code})${x.manager_department_name ? ` · ${x.manager_department_name}` : ''}`),
            h('dt', null, 'ดูแลบริษัท'), h('dd', null, `${x.target_company_name} (${x.target_company_code})`),
            h('dt', null, 'รับผิดชอบทีม'), h('dd', null, teamOf(x)),
            h('dt', null, 'พนักงานที่ดูแล'), h('dd', null, x.employee_id === null ? 'ทั้งทีม' : personOf(x.employee_code, x.employee_name, x.employee_masked, x.employee_company_code)),
            h('dt', null, 'ประเภท'), h('dd', null, x.type_label),
            h('dt', null, 'รายละเอียดหน้าที่'), h('dd', null, x.responsibility ?? '-'),
            h('dt', null, 'ช่วงวันที่มีผล'), h('dd', null, periodOf(x)),
            h('dt', null, 'สถานะ'), h('dd', null, h('span', { class: `badge-status ${STATE_CLASS[x.state]}` }, x.state_label), x.cancel_reason ? ` · ${x.cancel_reason}` : ''),
            h('dt', null, 'สร้าง / แก้ไขล่าสุด'), h('dd', null, `${fmtDate(x.created_at)} โดย ${x.created_by_name ?? '-'} · ${fmtDate(x.updated_at)} โดย ${x.updated_by_name ?? '-'}`)),
          h('p', { class: 'muted small' }, 'ความสัมพันธ์นี้ไม่เปลี่ยน "หัวหน้า (Reports To)" ของใคร และไม่นับเป็น Headcount ซ้ำ'),
          h('h3', null, 'ประวัติการเปลี่ยนแปลง'), historyList(hst)), [
          link(`/org-chart?company=${x.target_company_id}`, 'ดูในผังองค์กร', { class: 'btn' }),
          h('button', { class: 'btn primary', onclick: () => dlg.close() }, 'ปิด'),
        ]);
      } catch (e) {
        toast(msg(e), 'error');
      }
    };

    /** create (x undefined) or edit */
    const editor = (x?: Item) => {
      const err = h('div', { class: 'form-msg', role: 'alert' });
      let manager: { id: number; text: string; company_id: number; company_code: string } | null = x ? { id: x.manager_employee_id, text: personOf(x.manager_code, x.manager_name, x.manager_masked, x.manager_company_code), company_id: x.manager_live_company, company_code: x.manager_company_code } : null;
      let employee: { id: number; text: string } | null = x && x.employee_id !== null ? { id: x.employee_id, text: personOf(x.employee_code, x.employee_name, x.employee_masked, x.employee_company_code) } : null;
      const targetCo = h('select', { name: 'target_company_id', 'aria-label': 'บริษัทปลายทาง' }, h('option', { value: '' }, '— เลือกบริษัทปลายทาง —'), meta.companies.map((c) => h('option', { value: String(c.id), selected: x?.target_company_id === c.id }, `${c.code} · ${c.name}`)));
      const targetDep = h('select', { name: 'target_department_id', 'aria-label': 'หน่วยงาน / ทีมปลายทาง' });
      const team = h('input', { type: 'text', name: 'team_name', maxlength: 120, placeholder: 'เช่น Content Team (ไม่บังคับ)', value: x?.team_name ?? '', 'aria-label': 'ชื่อทีม' });
      const type = h('select', { name: 'relationship_type', 'aria-label': 'ประเภทความสัมพันธ์' }, meta.types.map((t) => h('option', { value: t.value, selected: (x?.relationship_type ?? 'team_lead') === t.value }, t.label)));
      const resp = h('textarea', { name: 'responsibility', rows: 2, maxlength: 1000, placeholder: 'หน้าที่ที่รับผิดชอบ', 'aria-label': 'รายละเอียดหน้าที่' }, x?.responsibility ?? '');
      const from = h('input', { type: 'date', name: 'effective_from', value: x?.effective_from ?? meta.today, 'aria-label': 'วันที่เริ่มมีผล' });
      const to = h('input', { type: 'date', name: 'effective_to', value: x?.effective_to ?? '', 'aria-label': 'วันที่สิ้นสุด' });
      const reason = h('input', { type: 'text', name: 'reason', maxlength: 500, placeholder: 'เหตุผลการแก้ไข (ไม่บังคับ)', 'aria-label': 'เหตุผลการแก้ไข' });
      const summary = h('p', { class: 'cca-sentence', 'aria-live': 'polite' });

      const picker = (label: string, name: string, query: () => Record<string, string | number | null>, onPick: (p: Person | null) => void, allowNone: string | null) => {
        const box = h('input', { type: 'search', name, placeholder: 'พิมพ์รหัสพนักงานหรือชื่อ', 'aria-label': label, autocomplete: 'off' });
        const list = h('div', { class: 'cca-results', role: 'listbox', 'aria-label': `ผลการค้นหา ${label}` });
        let t: ReturnType<typeof setTimeout> | undefined;
        const search = async () => {
          try {
            const r = await get<{ items: Person[] }>(`/api/org-assignments/people${qs({ q: box.value.trim(), ...query() })}`);
            mount(list,
              allowNone ? h('button', { type: 'button', class: 'cca-result', role: 'option', 'data-none': '1', onclick: () => { onPick(null); mount(list); } }, allowNone) : null,
              r.items.length ? r.items.map((p) => h('button', { type: 'button', class: 'cca-result', role: 'option', 'data-code': p.emp_code, onclick: () => { onPick(p); mount(list); box.value = ''; } },
                h('strong', null, `${p.emp_code} ${p.name}`), h('span', { class: 'muted small' }, ` · ${p.company_code} · ${p.department_name ?? 'ไม่ระบุหน่วยงาน'}${p.position_title ? ` · ${p.position_title}` : ''}`))) : h('div', { class: 'muted small' }, 'ไม่พบพนักงาน'));
          } catch (e) {
            mount(list, errorBox(e));
          }
        };
        box.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => void search(), 200);
        });
        box.addEventListener('focus', () => void search());
        // a new target company changes who is eligible: drop the old results
        return { box, list, reset: () => mount(list) };
      };
      const managerView = h('div', { class: 'cca-picked', 'data-role': 'manager' });
      const employeeView = h('div', { class: 'cca-picked', 'data-role': 'employee' });
      const fillDeps = () => {
        const co = Number(targetCo.value);
        mount(targetDep, h('option', { value: '' }, co ? '— เลือกหน่วยงาน / ทีม —' : '— เลือกบริษัทปลายทางก่อน —'),
          meta.departments.filter((d) => d.company_id === co).map((d) => h('option', { value: String(d.id), selected: x?.target_department_id === d.id && x.target_company_id === co }, `${d.name} (${d.code})`)));
      };
      const refresh = () => {
        mount(managerView, manager ? [h('strong', null, manager.text), h('span', { class: 'muted small' }, ` · ต้นสังกัด ${manager.company_code}`)] : h('span', { class: 'muted' }, 'ยังไม่ได้เลือกผู้รับผิดชอบ'));
        mount(employeeView, employee ? h('strong', null, employee.text) : h('span', { class: 'muted' }, 'ทั้งทีม (ไม่ระบุพนักงาน)'));
        for (const o of targetCo.options) o.disabled = !!manager && o.value === String(manager.company_id);
        const co = meta.companies.find((c) => String(c.id) === targetCo.value);
        const dep = meta.departments.find((d) => String(d.id) === targetDep.value);
        summary.textContent = manager && co && dep
          ? sentence({ manager: manager.text, managerCompany: manager.company_code, type: ASSIGNMENT_TYPE_LABEL[type.value as AssignmentType], team: `${dep.name}${team.value.trim() ? ` / ${team.value.trim()}` : ''}`, targetCompany: co.code, employee: employee?.text ?? null, from: from.value, to: to.value || null })
          : 'เลือกผู้รับผิดชอบ บริษัทปลายทาง และหน่วยงาน / ทีม เพื่อดูสรุป';
      };
      const mgrPick = picker('ค้นหาผู้รับผิดชอบ (หัวหน้างาน) จากทุกบริษัท', 'manager_search', () => ({ exclude_company: targetCo.value || null }), (p) => {
        if (p) manager = { id: p.id, text: `${p.emp_code} ${p.name}${p.department_name ? ` · ${p.department_name}` : ''}`, company_id: p.company_id, company_code: p.company_code };
        refresh();
      }, null);
      const empPick = picker('ค้นหาพนักงานในบริษัทปลายทาง', 'employee_search', () => ({ company: targetCo.value || -1 }), (p) => {
        employee = p ? { id: p.id, text: `${p.emp_code} ${p.name}` } : null;
        refresh();
      }, 'ทั้งทีม (ไม่ระบุพนักงาน)');
      targetCo.addEventListener('change', () => {
        fillDeps();
        employee = null;
        mgrPick.reset();
        empPick.reset();
        // a responsible person of the newly chosen target company is no longer cross-company
        if (manager && String(manager.company_id) === targetCo.value) manager = null;
        refresh();
      });
      for (const el of [targetDep, team, type, from, to]) el.addEventListener('input', refresh);
      for (const el of [targetDep, type]) el.addEventListener('change', refresh);
      fillDeps();
      refresh();

      const dlg = modal(x ? `แก้ไขความสัมพันธ์ข้ามบริษัท #${x.id}` : 'เพิ่มความสัมพันธ์ข้ามบริษัท', h('div', { class: 'grid-form cca-form' },
        h('div', { class: 'field span2' }, h('span', null, '1. ผู้รับผิดชอบ / หัวหน้างาน (ค้นหาได้ทุกบริษัท) *'), mgrPick.box, mgrPick.list, managerView),
        h('label', { class: 'field' }, h('span', null, '2. บริษัทปลายทาง (ที่ดูแล) *'), targetCo),
        h('label', { class: 'field' }, h('span', null, '3. หน่วยงาน / ทีมปลายทาง *'), targetDep),
        h('label', { class: 'field' }, h('span', null, 'ชื่อทีม (ถ้ามี)'), team),
        h('label', { class: 'field' }, h('span', null, '4. ประเภทความสัมพันธ์ *'), type),
        h('div', { class: 'field span2' }, h('span', null, '5. พนักงานที่ดูแลในบริษัทปลายทาง (ไม่บังคับ — ไม่ระบุ = ทั้งทีม)'), empPick.box, empPick.list, employeeView),
        h('label', { class: 'field span2' }, h('span', null, '6. รายละเอียดหน้าที่รับผิดชอบ'), resp),
        h('label', { class: 'field' }, h('span', null, '7. วันที่เริ่มมีผล *'), from),
        h('label', { class: 'field' }, h('span', null, 'วันที่สิ้นสุด (ถ้ามี)'), to),
        x ? h('label', { class: 'field span2' }, h('span', null, 'เหตุผลการแก้ไข'), reason) : null,
        h('div', { class: 'field span2' }, h('span', null, 'สรุป'), summary),
        h('p', { class: 'muted small span2' }, 'ความสัมพันธ์นี้เป็นความรับผิดชอบด้านการทำงาน (Functional) ไม่เปลี่ยน "หัวหน้า (Reports To)" ของใคร และไม่ย้ายบริษัทของพนักงาน'),
        err), [
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
        h('button', { class: 'btn primary', 'data-act': 'save', onclick: async () => {
          err.textContent = '';
          if (!manager) return void (err.textContent = 'กรุณาเลือกผู้รับผิดชอบ');
          const body = {
            manager_employee_id: manager.id, target_company_id: targetCo.value ? Number(targetCo.value) : null, target_department_id: targetDep.value ? Number(targetDep.value) : null,
            team_name: team.value.trim() || null, employee_id: employee?.id ?? null, relationship_type: type.value, responsibility: resp.value.trim() || null,
            effective_from: from.value || null, effective_to: to.value || null, ...(x ? { reason: reason.value.trim() || null } : {}),
          };
          try {
            const saved = x ? await put<Item>(`/api/org-assignments/${x.id}`, body) : await post<Item>('/api/org-assignments', body);
            dlg.close();
            toast(x ? 'บันทึกการแก้ไขแล้ว' : 'บันทึกความสัมพันธ์ข้ามบริษัทแล้ว');
            await load();
            const ok = modal('บันทึกเรียบร้อย', h('div', { class: 'stack' }, h('p', { class: 'cca-sentence', 'data-saved': saved.id }, itemSentence(saved)), h('p', null, 'สถานะ: ', h('span', { class: `badge-status ${STATE_CLASS[saved.state]}` }, saved.state_label)),
              h('p', { class: 'muted small' }, saved.state === 'active' ? 'ผังองค์กรแสดงความสัมพันธ์นี้แล้ว (เส้นประ + การ์ดอ้างอิงในทีมปลายทาง)' : 'ผังองค์กรจะแสดงเมื่อถึงวันที่มีผลและสถานะใช้งาน')), [
              link(`/org-chart?company=${saved.target_company_id}`, 'ดูในผังองค์กร', { class: 'btn' }),
              h('button', { class: 'btn primary', onclick: () => ok.close() }, 'ปิด'),
            ]);
          } catch (e) {
            err.textContent = msg(e);
          }
        } }, 'บันทึก'),
      ]);
    };

    mount(main,
      h('p', { class: 'muted' }, 'กำหนดผู้รับผิดชอบ / หัวหน้างานจากบริษัทหนึ่งให้ดูแลทีมของอีกบริษัท แยกจากสายบังคับบัญชาหลัก (Reports To) — ผังองค์กรแสดงเป็นเส้นประและการ์ดอ้างอิงในทีมปลายทาง'),
      h('div', { class: 'toolbar' }, q, stateSel, typeSel, coSel, count, h('div', { class: 'spacer' }),
        link('/org-chart', 'ผังองค์กร', { class: 'btn small' }),
        meta.canManage ? h('button', { class: 'btn small primary', 'data-act': 'create', onclick: () => editor() }, '+ เพิ่มความสัมพันธ์ข้ามบริษัท') : null),
      out);
    await load();
  } catch (e) {
    mount(main, errorBox(e));
  }
}
