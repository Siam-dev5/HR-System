import type { DashboardResponse, LookupOption, NineBoxResponse, WorkflowRequestRow } from '../../shared/types';
import { get, post, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtMoney, fmtNum, toast, promptDialog } from '../dom';
import { optionLabel } from '../labels';
import { can, isSuperAdmin, link, state } from '../app';
import { optionText } from './crud';

function bars(rows: Array<{ label: string; value: number }>): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' }, rows.length ? rows.map((r) => h('div', { class: 'bar-row' },
    h('span', { class: 'bar-label' }, r.label),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${(r.value / max) * 100}%` })),
    h('span', { class: 'bar-value' }, fmtNum(r.value)))) : h('div', { class: 'empty' }, 'ไม่มีข้อมูล'));
}

const kpi = (label: string, value: string | number, href: string | null, sub?: string) => {
  const body = [h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)), sub ? h('div', { class: 'muted small' }, sub) : null];
  // a KPI only becomes a link when the API says the target is accessible
  return href ? link(href, body, { class: 'kpi card link-card' }) : h('div', { class: 'kpi card' }, body);
};

export async function renderDashboard(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<DashboardResponse>('/api/dashboard');
    mount(main,
      h('div', { class: 'kpis' },
        d.kpis.map((k) => kpi(k.label, fmtNum(k.value), k.href)),
        can('workflow.view') ? kpi('คำขอรออนุมัติ', d.pendingApprovals, '/workflow/inbox') : null),
      h('div', { class: 'grid2' },
        d.headcountByDepartment.length ? h('section', { class: 'card' }, h('h2', null, 'กำลังคนตามหน่วยงาน'), bars(d.headcountByDepartment.map((r) => ({ label: r.department, value: r.count })))) : null,
        d.nineBox ? h('section', { class: 'card' }, h('h2', null, 'Talent 9-Box (รอบล่าสุด)'),
          h('div', { class: 'ninebox small' }, d.nineBox.map((b) => {
            const body = [h('strong', null, String(b.count)), h('span', null, b.title)];
            return b.href ? link(b.href, body, { class: `box box-${b.box}` }) : h('div', { class: `box box-${b.box}` }, body);
          })),
          h('div', { class: 'axis muted small' }, 'แนวนอน: ผลงาน → · แนวตั้ง: ศักยภาพ ↑')) : null,
        h('section', { class: 'card' }, h('h2', null, 'การแจ้งเตือนล่าสุด'),
          d.notifications.length ? h('ul', { class: 'list' }, d.notifications.map((n) => h('li', null,
            n.href ? (n.external ? h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, `${n.title} ↗`) : link(n.href.slice((state.meta?.basePath ?? '').replace(/\/+$/, '').length) || '/', n.title)) : h('span', null, n.title),
            n.body ? h('div', { class: 'muted small' }, n.body) : null))) : h('div', { class: 'empty' }, 'ไม่มีการแจ้งเตือน')),
      ),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

interface EssData {
  linked: boolean;
  employee: Record<string, string | number | null> | null;
  today: { clock_in: string | null; clock_out: string | null; status: string } | null;
  leaveBalances: Array<{ id: number; name: string; entitled: number; used: number }>;
  requests: Array<{ id: number; summary: string; status: string; created_at: string }>;
  payslips: Array<{ id: number; period_name: string; pay_date: string; net: number }>;
}

export async function renderEss(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<EssData>('/api/ess');
    if (!d.linked) {
      mount(main, h('div', { class: 'card' }, h('h2', null, `สวัสดี ${state.meta?.me.displayName ?? ''}`),
        h('p', null, 'บัญชีนี้ยังไม่ได้ผูกกับข้อมูลพนักงาน จึงยังไม่มีข้อมูลส่วนตัว วันลา หรือสลิปเงินเดือนให้แสดง'),
        h('p', { class: 'muted' }, isSuperAdmin() ? 'ผูกบัญชีกับพนักงานได้ที่เมนู ผู้ใช้ระบบ' : 'กรุณาติดต่อผู้ดูแลระบบเพื่อผูกบัญชีกับข้อมูลพนักงาน')));
      return;
    }
    const e = d.employee ?? {};
    const clock = async (action: 'in' | 'out') => {
      try {
        const r = await post<{ time: string; status?: string }>('/api/ess/clock', { action });
        toast(`${action === 'in' ? 'ลงเวลาเข้า' : 'ลงเวลาออก'} ${r.time} น.${r.status === 'late' ? ' (สาย)' : ''}`);
        void renderEss(main);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    mount(main,
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', null, `${e.first_name ?? ''} ${e.last_name ?? ''}`),
          h('dl', { class: 'dl' }, h('dt', null, 'รหัสพนักงาน'), h('dd', null, String(e.emp_code ?? '-')), h('dt', null, 'หน่วยงาน'), h('dd', null, String(e.department ?? '-')),
            h('dt', null, 'ตำแหน่ง'), h('dd', null, String(e.position ?? '-')), h('dt', null, 'วันเริ่มงาน'), h('dd', null, fmtDate(e.hire_date)), h('dt', null, 'สถานะ'), h('dd', null, optionLabel(e.status as string)))),
        h('section', { class: 'card' }, h('h2', null, 'ลงเวลาวันนี้'),
          h('p', null, `เข้า: ${d.today?.clock_in ?? '-'} · ออก: ${d.today?.clock_out ?? '-'}`, d.today ? ` · ${optionLabel(d.today.status)}` : ''),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', disabled: !!d.today?.clock_in, onclick: () => void clock('in') }, 'ลงเวลาเข้า'),
            h('button', { class: 'btn', disabled: !d.today?.clock_in || !!d.today?.clock_out, onclick: () => void clock('out') }, 'ลงเวลาออก'))),
      ),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', null, 'วันลาคงเหลือปีนี้'),
          h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'ประเภท'), h('th', null, 'สิทธิ์'), h('th', null, 'ใช้ไป'), h('th', null, 'คงเหลือ'))),
            h('tbody', null, d.leaveBalances.map((b) => h('tr', null, h('td', null, b.name), h('td', null, fmtNum(b.entitled)), h('td', null, fmtNum(b.used)), h('td', null, fmtNum(b.entitled - b.used)))))),
          can('leave.create') ? link('/leave', 'ยื่นคำขอลา', { class: 'btn' }) : null),
        h('section', { class: 'card' }, h('h2', null, 'คำขอล่าสุดของฉัน'),
          d.requests.length ? h('ul', { class: 'list' }, d.requests.map((r) => h('li', null, r.summary, ' · ', h('span', { class: `badge-status s-${r.status}` }, optionLabel(r.status))))) : h('div', { class: 'empty' }, 'ยังไม่มีคำขอ'),
          link('/workflow/inbox', 'ดูทั้งหมด', { class: 'btn small' })),
      ),
      h('section', { class: 'card' }, h('h2', null, 'สลิปเงินเดือนล่าสุด'),
        d.payslips.length ? h('ul', { class: 'list' }, d.payslips.map((p) => h('li', null, link(`/my/payslips/${p.id}`, `${p.period_name} · จ่าย ${fmtDate(p.pay_date)} · สุทธิ ${fmtMoney(p.net)} บาท`)))) : h('div', { class: 'empty' }, 'ยังไม่มีสลิปที่เผยแพร่'),
        link('/my/payslips', 'สลิปทั้งหมด', { class: 'btn small' })),
    );
  } catch (err) {
    mount(main, errorBox(err));
  }
}

interface AnalyticsData {
  range: { from: string; to: string; departmentId: number | null };
  departments: LookupOption[];
  metrics: Record<string, number>;
  byDepartment: Array<{ label: string; value: number }>;
  enps: { responses: number; score: number } | null;
}

export async function renderAnalytics(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<AnalyticsData>(`/api/analytics${qs({ from: params.get('from'), to: params.get('to'), department_id: params.get('department_id') })}`);
    const from = h('input', { type: 'date', value: d.range.from });
    const to = h('input', { type: 'date', value: d.range.to });
    const dep = h('select', null, h('option', { value: '' }, 'ทุกหน่วยงาน'), d.departments.map((o) => h('option', { value: String(o.value), selected: o.value === d.range.departmentId }, optionText(o))));
    const apply = () => {
      const p = new URLSearchParams({ from: from.value, to: to.value });
      if (dep.value) p.set('department_id', dep.value);
      history.replaceState(null, '', `?${p.toString()}`);
      void renderAnalytics(main, p);
    };
    const m = d.metrics;
    mount(main,
      h('form', { class: 'toolbar', onsubmit: (e: Event) => { e.preventDefault(); apply(); } },
        h('label', { class: 'field inline' }, h('span', null, 'ตั้งแต่'), from), h('label', { class: 'field inline' }, h('span', null, 'ถึง'), to),
        h('label', { class: 'field inline' }, h('span', null, 'หน่วยงาน (รวมหน่วยงานย่อย)'), dep), h('button', { class: 'btn primary', type: 'submit' }, 'ใช้ตัวกรอง')),
      h('div', { class: 'kpis' },
        kpi('กำลังคนปัจจุบัน', fmtNum(m.headcount), null), kpi('รับเข้าในช่วง', fmtNum(m.hires), null), kpi('พ้นสภาพในช่วง', fmtNum(m.leavers), null),
        kpi('อัตราลาออก', `${fmtNum(m.turnover)}%`, null), kpi('วันลา (อนุมัติ)', fmtNum(m.leaveDays), null), kpi('ชั่วโมง OT (อนุมัติ)', fmtNum(m.otHours), null),
        kpi('ครั้งที่มาสาย', fmtNum(m.lateDays), null), kpi('ชั่วโมงอบรม', fmtNum(m.trainingHours), null),
        kpi('eNPS', d.enps ? String(d.enps.score) : '-', null, d.enps ? `${d.enps.responses} คำตอบ` : 'ไม่มีแบบสำรวจ eNPS ในช่วงนี้')),
      h('section', { class: 'card' }, h('h2', null, 'กำลังคนตามหน่วยงาน'), bars(d.byDepartment)),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderTalent(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<NineBoxResponse>(`/api/talent/ninebox${qs({ cycle_id: params.get('cycle_id') })}`);
    const focus = Number(params.get('box')) || null;
    const cycle = h('select', { onchange: () => void renderTalent(main, new URLSearchParams({ cycle_id: cycle.value })) }, d.cycles.map((c) => h('option', { value: String(c.value), selected: c.value === d.cycleId }, c.label)));
    const order = [7, 8, 9, 4, 5, 6, 1, 2, 3];
    mount(main,
      h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'รอบประเมิน'), cycle), h('div', { class: 'spacer' }),
        can('talent_assessments.view') ? link('/talent/assessments', 'ข้อมูลประเมิน Talent', { class: 'btn' }) : null),
      d.cycles.length ? null : h('div', { class: 'empty' }, 'ยังไม่มีรอบประเมิน'),
      h('div', { class: 'ninebox' }, order.map((n) => {
        const b = d.boxes.find((x) => x.box === n);
        if (!b) return null;
        return h('div', { class: `box box-${n} ${focus === n ? 'focus' : ''}`, id: `box-${n}` },
          h('div', { class: 'box-head' }, h('strong', null, b.title), h('span', { class: 'muted small' }, `ผลงาน ${b.performance} · ศักยภาพ ${b.potential}`)),
          b.employees.length ? h('ul', null, b.employees.map((e) => h('li', null, e.name))) : h('div', { class: 'muted small' }, '—'));
      })),
      h('div', { class: 'axis muted small' }, 'แนวนอน: ผลงาน (ต่ำ → สูง) · แนวตั้ง: ศักยภาพ (ล่าง → บน)'),
    );
    if (focus) document.getElementById(`box-${focus}`)?.scrollIntoView({ block: 'center' });
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderOrganization(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const rows = await get<Array<{ id: number; code: string; name: string; parent_id: number | null; head: string | null; headcount: number }>>('/api/organization');
    const ids = new Set(rows.map((r) => r.id));
    const node = (parent: number | null): HTMLElement | null => {
      const kids = rows.filter((r) => (parent === null ? r.parent_id === null || !ids.has(r.parent_id) : r.parent_id === parent));
      if (!kids.length) return null;
      return h('ul', { class: 'tree' }, kids.map((k) => h('li', null,
        h('div', { class: 'tree-node' }, h('strong', null, `${k.name} (${k.code})`), h('span', { class: 'muted small' }, ` · ${k.headcount} คน${k.head ? ` · ${k.head}` : ''}`)),
        node(k.id))));
    };
    mount(main, h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), can('departments.view') ? link('/departments', 'จัดการหน่วยงาน', { class: 'btn' }) : null),
      h('section', { class: 'card' }, node(null) ?? h('div', { class: 'empty' }, 'ยังไม่มีหน่วยงาน')));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderWorkflowInbox(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<{ toApprove: WorkflowRequestRow[]; mine: WorkflowRequestRow[] }>('/api/workflow/inbox');
    const decide = async (r: WorkflowRequestRow, decision: 'approved' | 'rejected') => {
      const comment = await promptDialog(decision === 'approved' ? 'อนุมัติคำขอ' : 'ไม่อนุมัติคำขอ', 'หมายเหตุ (ถ้ามี)', decision === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ');
      if (comment === null) return;
      try {
        await post(`/api/workflow/${r.id}/decide`, { decision, comment: comment || undefined });
        toast(decision === 'approved' ? 'อนุมัติแล้ว' : 'บันทึกการไม่อนุมัติแล้ว');
        void renderWorkflowInbox(main);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    };
    const table = (rows: WorkflowRequestRow[], actions: boolean) => rows.length
      ? h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'คำขอ'), h('th', null, 'ผู้ยื่น'), h('th', null, 'ขั้น'), h('th', null, 'สถานะ'), h('th', null, 'วันที่ยื่น'), actions ? h('th', null, '') : null)),
          h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.summary), h('td', null, r.requester), h('td', null, r.stepName ?? `#${r.currentStep}`),
            h('td', null, h('span', { class: `badge-status s-${r.status}` }, optionLabel(r.status))), h('td', null, fmtDate(r.createdAt)),
            actions ? h('td', { class: 'actions' }, h('button', { class: 'btn small primary', onclick: () => void decide(r, 'approved') }, 'อนุมัติ'), h('button', { class: 'btn small danger', onclick: () => void decide(r, 'rejected') }, 'ไม่อนุมัติ')) : null))))
      : h('div', { class: 'empty' }, 'ไม่มีรายการ');
    mount(main,
      h('section', { class: 'card' }, h('h2', null, `รออนุมัติโดยฉัน (${d.toApprove.length})`), table(d.toApprove, true)),
      h('section', { class: 'card' }, h('h2', null, 'คำขอที่ฉันยื่น'), table(d.mine, false)),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}
