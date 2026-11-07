// "ยกเว้นการบันทึกเวลา" section of the employee form: the employee's exemption periods with their status and history,
// and (with attendance_exemption.manage) add / end / revoke. Its own API (/api/attendance-exemptions), outside the
// employee form's save, like the photo panel. Nothing here changes payroll, leave or overtime.
import { EXEMPTION_STATE_LABEL, type ExemptionState } from '../../shared/exemptions';
import { get, post, put, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, toast, promptDialog } from '../dom';
import { can } from '../app';

interface Period {
  id: number;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  state: ExemptionState;
  created_at: string;
  created_by_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
  revoked_at: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
}
interface Response {
  today: string;
  active: boolean;
  items: Period[];
}

const STATE_CLASS: Record<ExemptionState, string> = { active: 's-ok', future: 's-pending', expired: 's-superseded', revoked: 's-error' };

export function exemptionPanel(employeeId: number): HTMLElement {
  const body = h('div', null, loading());
  const panel = h('section', { class: 'exemption-panel span2', 'aria-label': 'ยกเว้นการบันทึกเวลา', 'data-employee': employeeId },
    h('div', { class: 'exemption-head' }, h('strong', null, 'ยกเว้นการบันทึกเวลา (Attendance Exemption)')), body);
  const manage = can('attendance_exemption.manage');
  const msg = h('div', { class: 'form-msg', role: 'alert' });

  const run = async (action: () => Promise<unknown>, done: string) => {
    msg.textContent = '';
    try {
      await action();
      toast(done);
      await load();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  };

  const addForm = () => {
    const from = h('input', { type: 'date', name: 'effective_from', 'aria-label': 'วันที่เริ่มมีผล', required: true });
    const to = h('input', { type: 'date', name: 'effective_to', 'aria-label': 'วันที่สิ้นสุด (ไม่บังคับ)' });
    const reason = h('input', { type: 'text', name: 'reason', maxlength: 500, 'aria-label': 'เหตุผล', placeholder: 'เช่น ตำแหน่งผู้บริหารตามข้อตกลง' });
    return h('div', { class: 'exemption-add' },
      h('label', { class: 'field' }, h('span', null, 'เริ่มมีผล *'), from),
      h('label', { class: 'field' }, h('span', null, 'สิ้นสุด (เว้นว่าง = ไม่กำหนด)'), to),
      h('label', { class: 'field exemption-reason' }, h('span', null, 'เหตุผล *'), reason),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => void run(() => post('/api/attendance-exemptions', { employee_id: employeeId, effective_from: from.value, effective_to: to.value || null, reason: reason.value }), 'บันทึกช่วงยกเว้นแล้ว') }, '+ เพิ่มช่วงยกเว้น'));
  };

  const load = async () => {
    try {
      const r = await get<Response>(`/api/attendance-exemptions${qs({ employee_id: employeeId })}`);
      mount(body,
        h('p', { class: 'exemption-status' }, 'สถานะวันนี้: ', h('span', { class: `badge-status ${r.active ? 's-ok' : 's-superseded'}` }, r.active ? 'ได้รับยกเว้น' : 'ไม่ได้รับยกเว้น'),
          h('span', { class: 'muted small' }, ' · มีผลเฉพาะการแจ้งเตือนของการนำเข้าเวลา ไม่กระทบเงินเดือน การลา หรือ OT')),
        r.items.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact exemption-table' },
              h('thead', null, h('tr', null, ['ช่วงวันที่', 'เหตุผล', 'สถานะ', 'ประวัติ', manage ? '' : null].filter((x) => x !== null).map((t) => h('th', null, t)))),
              h('tbody', null, r.items.map((p) => h('tr', { 'data-state': p.state },
                h('td', null, `${fmtDate(p.effective_from)} – ${p.effective_to ? fmtDate(p.effective_to) : 'ไม่กำหนด'}`),
                h('td', null, p.reason),
                h('td', null, h('span', { class: `badge-status ${STATE_CLASS[p.state]}` }, EXEMPTION_STATE_LABEL[p.state])),
                h('td', { class: 'small muted' },
                  h('div', null, `สร้าง ${fmtDate(p.created_at)} โดย ${p.created_by_name ?? '-'}`),
                  p.updated_at !== p.created_at && !p.revoked_at ? h('div', null, `แก้ไข ${fmtDate(p.updated_at)} โดย ${p.updated_by_name ?? '-'}`) : null,
                  p.revoked_at ? h('div', null, `ยกเลิก ${fmtDate(p.revoked_at)} โดย ${p.revoked_by_name ?? '-'}: ${p.revoke_reason ?? ''}`) : null),
                manage ? h('td', { class: 'actions' }, p.state === 'revoked' ? null : [
                  p.state !== 'expired' ? h('button', { type: 'button', class: 'btn small', onclick: async () => {
                    const end = await promptDialog('สิ้นสุดการยกเว้น', 'วันที่สิ้นสุด (YYYY-MM-DD)', 'บันทึก');
                    if (end) void run(() => put(`/api/attendance-exemptions/${p.id}`, { effective_to: end.trim() }), 'บันทึกวันที่สิ้นสุดแล้ว');
                  } }, 'กำหนดวันสิ้นสุด') : null,
                  h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
                    const why = await promptDialog('ยกเลิกช่วงยกเว้น', 'เหตุผลที่ยกเลิก', 'ยกเลิกช่วงนี้');
                    if (why) void run(() => post(`/api/attendance-exemptions/${p.id}/revoke`, { reason: why }), 'ยกเลิกช่วงยกเว้นแล้ว');
                  } }, 'ยกเลิก'),
                ]) : null)))))
          : h('p', { class: 'muted' }, 'ยังไม่มีช่วงยกเว้นการบันทึกเวลา'),
        manage ? addForm() : null,
        msg);
    } catch (e) {
      mount(body, errorBox(e));
    }
  };
  void load();
  return panel;
}
