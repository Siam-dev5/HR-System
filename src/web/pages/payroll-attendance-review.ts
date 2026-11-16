// HR attendance review before Calculate (migration 0025): HR checks, per company of the period, the expected and actual
// worked days, the unpaid leave and confirmed absence the calculation will deduct, and the anomalies still waiting for
// review, then confirms exactly the attendance version shown. The API refuses Calculate until every company it pays
// has a confirmation matching the attendance as it is now. The days actually worked are shown for control only: they
// never multiply the salary.
import type { PayrollPeriod } from '../../shared/types';
import { get, post } from '../api';
import { h, modal, toast, fmtDate, confirmDialog } from '../dom';

interface ReviewView {
  id: number;
  status: 'confirmed' | 'superseded' | 'invalidated';
  attendance_version: string;
  judged_through: string;
  confirmed_by: string | null;
  confirmed_at: string;
  note: string | null;
  ended_at: string | null;
  ended_reason: string | null;
}
interface Deduction { date: string; kind: 'unpaid_leave' | 'absence'; days: number; leave?: { source: string; id: number }; record?: number }
interface Employee {
  employee_id: number; emp_code: string; name: string; company_id: number;
  entitlementDays: number; calendarEntitled: boolean | null; expectedWorkDays: number; actualWorkDays: number; actualWorkHours: number;
  unpaidLeaveDays: number; absenceDays: number; payableDays: number; paidLeaveDays: number;
  missingAttendanceDays: number; unverifiedDays: number; pendingLeaveDays: number; unclassifiedLeaveDays: number; invalidRecords: number; pendingReviewRecords: number;
  deductions: Deduction[];
}
interface ReviewResponse {
  period: { id: number; code: string; status: string; kind: string; start_date: string; end_date: string };
  judgedThrough: string;
  canConfirm: boolean;
  companies: Array<{ company_id: number; company: string | null; status: 'pending' | 'confirmed' | 'changed'; version: string; review: ReviewView | null; invalidated: ReviewView | null; employees: number }>;
  employees: Employee[];
  records: Array<{ id: number; employee_id: number; company_id: number; work_date: string; status: string; clock_in: string | null; clock_out: string | null; issues: Array<{ message: string }> }>;
  dayIssues: Array<{ employee_id: number; company_id: number; work_date: string; message: string }>;
  history: Array<ReviewView & { company_id: number }>;
}

const STATUS: Record<'pending' | 'confirmed' | 'changed', { label: string; cls: string }> = {
  pending: { label: 'รอ HR ตรวจสอบ', cls: 's-pending' },
  confirmed: { label: 'ยืนยันแล้ว', cls: 's-approved' },
  changed: { label: 'ข้อมูลเปลี่ยน ต้องตรวจใหม่', cls: 's-rejected' },
};
const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

function anomalies(e: Employee): string {
  const out: string[] = [];
  if (e.pendingReviewRecords) out.push(`รอตรวจสอบ ${e.pendingReviewRecords} บันทึก (ไม่หักเงิน)`);
  if (e.invalidRecords) out.push(`บันทึกไม่ถูกต้อง ${e.invalidRecords} (ต้องแก้ไข)`);
  if (e.missingAttendanceDays) out.push(`ไม่มีบันทึกเวลา ${e.missingAttendanceDays} วัน (ไม่อนุมานเป็นขาดงาน)`);
  if (e.pendingLeaveDays) out.push(`ใบลารออนุมัติ ${e.pendingLeaveDays} วัน`);
  if (e.unclassifiedLeaveDays) out.push(`ลาจาก Feishu ไม่ทราบประเภท ${e.unclassifiedLeaveDays} วัน`);
  return out.join(' · ') || '-';
}

/** Opens the review of a period; `done` reloads the period list after a confirmation. */
export async function attendanceReview(p: Pick<PayrollPeriod, 'id' | 'code' | 'name'>, done: () => void): Promise<void> {
  let d: ReviewResponse;
  try {
    d = await get<ReviewResponse>(`/api/payroll/periods/${p.id}/attendance-review`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  const byCompany = (id: number) => d.employees.filter((e) => e.company_id === id);
  const name = (id: number) => d.employees.find((e) => e.employee_id === id)?.emp_code ?? `#${id}`;
  const body = h('div', { class: 'attendance-review' },
    h('p', { class: 'muted' }, `งวด ${d.period.code} · ${fmtDate(d.period.start_date)} – ${fmtDate(d.period.end_date)} · ตรวจข้อมูลถึง ${fmtDate(d.judgedThrough)} · `,
      'วันทำงานจริงใช้ตรวจสอบเท่านั้น ไม่ใช้คูณเงินเดือน · หักเงินเฉพาะลาไม่รับค่าจ้างที่อนุมัติแล้ว และบันทึก "ขาดงาน" ที่ HR ยืนยัน (ไม่หักวันหยุด / ลาที่ได้รับค่าจ้าง / บันทึกที่รอตรวจสอบ)'),
    d.companies.length ? null : h('div', { class: 'empty' }, 'ไม่มีพนักงานในงวดนี้ (ในบริษัทที่คุณมีสิทธิ์)'),
    d.companies.map((co) => {
      const st = STATUS[co.status];
      const rows = byCompany(co.company_id);
      const confirm = async () => {
        if (!(await confirmDialog('ยืนยันผลตรวจสอบเวลาทำงาน', `ยืนยันว่าตรวจสอบวันทำงานจริง วันลาไม่รับค่าจ้าง และวันขาดงานของ ${co.company ?? ''} (${rows.length} คน) ตามที่แสดงแล้ว? หากข้อมูลเวลาทำงานเปลี่ยนภายหลัง การยืนยันนี้จะถูกยกเลิกอัตโนมัติ`, 'ยืนยันผลตรวจสอบ'))) return;
        try {
          await post(`/api/payroll/periods/${p.id}/attendance-review/confirm`, { company_id: co.company_id, version: co.version });
          toast('ยืนยันผลตรวจสอบเวลาทำงานแล้ว');
          view.close();
          done();
          void attendanceReview(p, done);
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      };
      return h('section', { class: 'card' },
        h('div', { class: 'toolbar' }, h('h3', null, co.company ?? `บริษัท #${co.company_id}`), h('span', { class: `badge-status ${st.cls}` }, st.label), h('div', { class: 'spacer' }),
          d.canConfirm && co.status !== 'confirmed' ? h('button', { class: 'btn small primary', onclick: () => void confirm() }, 'ยืนยันผลตรวจสอบ') : null),
        co.review ? h('p', { class: 'muted small' }, `ยืนยันโดย ${co.review.confirmed_by ?? '-'} เมื่อ ${co.review.confirmed_at} · ข้อมูลถึง ${fmtDate(co.review.judged_through)} · เวอร์ชัน ${co.review.attendance_version.slice(0, 16)}…${co.review.note ? ` · ${co.review.note}` : ''}`) : null,
        co.invalidated ? h('div', { class: 'alert' }, `การยืนยันเดิม (#${co.invalidated.id} โดย ${co.invalidated.confirmed_by ?? '-'}) ถูกยกเลิก เพราะข้อมูลเวลาทำงานเปลี่ยนหลังยืนยัน ต้องตรวจสอบใหม่`) : null,
        co.status === 'changed' || co.status === 'pending' ? h('p', { class: 'small' }, 'ยังคำนวณงวดนี้ไม่ได้จนกว่า HR จะยืนยันผลตรวจสอบของบริษัทนี้') : null,
        h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, ['รหัส', 'ชื่อ', 'วันมีสิทธิ์เงินเดือน', 'วันทำงานตามตาราง (Expected)', 'วันทำงานจริง', 'ชั่วโมงจริง', 'ลาไม่รับค่าจ้าง', 'ขาดงาน (ยืนยัน)', 'วันจ่ายจริง', 'วันที่หัก', 'รายการผิดปกติ / รอตรวจสอบ'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.map((e) => h('tr', null,
            h('td', null, e.emp_code), h('td', null, e.name),
            h('td', { class: 'num', title: e.calendarEntitled ? 'สิทธิ์ 16 วันตามปฏิทิน (เดือนที่ลงท้ายด้วย "คม" และเริ่มงานก่อนวันที่ 26)' : '' }, `${n(e.entitlementDays)}${e.calendarEntitled ? ' *' : ''}`),
            h('td', { class: 'num' }, n(e.expectedWorkDays)), h('td', { class: 'num' }, n(e.actualWorkDays)), h('td', { class: 'num' }, n(e.actualWorkHours)),
            h('td', { class: 'num' }, n(e.unpaidLeaveDays)), h('td', { class: 'num' }, n(e.absenceDays)), h('td', { class: 'num' }, h('strong', null, n(e.payableDays))),
            h('td', null, e.deductions.length ? e.deductions.map((x) => `${fmtDate(x.date)} ${x.kind === 'absence' ? `ขาดงาน (บันทึก #${x.record})` : `ลาไม่รับค่าจ้าง ${n(x.days)} วัน (ใบลา #${x.leave?.id})`}`).join(', ') : '-'),
            h('td', { class: 'small' }, anomalies(e))))))),
      );
    }),
    d.records.length
      ? h('section', { class: 'card' }, h('h3', null, 'บันทึกเวลาที่รอตรวจสอบ / ไม่ถูกต้อง (ไม่ถูกนำไปหักเงิน)'),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
            h('thead', null, h('tr', null, ['พนักงาน', 'วันที่', 'เข้า', 'ออก', 'สถานะ', 'เหตุผล'].map((t) => h('th', null, t)))),
            h('tbody', null, d.records.map((r) => h('tr', null, h('td', null, name(r.employee_id)), h('td', null, fmtDate(r.work_date)), h('td', null, r.clock_in ?? '-'), h('td', null, r.clock_out ?? '-'),
              h('td', null, r.status === 'invalid' ? 'ไม่ถูกต้อง (ต้องแก้ไข)' : 'รอ HR ตรวจสอบ'), h('td', null, r.issues.map((i) => i.message).join(' · '))))))))
      : null,
    d.history.length
      ? h('details', null, h('summary', null, `ประวัติการยืนยัน (${d.history.length})`),
          h('ul', { class: 'small' }, d.history.map((r) => h('li', null, `#${r.id} · บริษัท #${r.company_id} · ${r.status === 'confirmed' ? 'มีผล' : r.status === 'superseded' ? 'ถูกแทนที่' : 'ยกเลิก (ข้อมูลเปลี่ยน)'} · ${r.confirmed_by ?? '-'} ${r.confirmed_at}${r.ended_at ? ` → ${r.ended_at}` : ''}`))))
      : null,
  );
  const view = modal(`ตรวจสอบเวลาทำงานก่อนคำนวณ · ${p.name}`, body);
}
