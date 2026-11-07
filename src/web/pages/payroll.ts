import type { DeletedPeriod, PayrollPeriod, PayslipDetail, PayslipSummary, PayslipYtd, PeriodImpact, WageSegmentView } from '../../shared/types';
import { PROBATION_LABEL } from '../../shared/payroll-columns';
import { PERIOD_ADMIN } from '../../shared/permissions';
import { get, post, put, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtMoney, modal, toast, confirmDialog, promptDialog } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, isSuperAdmin, link, state } from '../app';

/** Super Admin period controls are shown only to the super_admin role holding the permission (the API checks both). */
const adminCan = (perm: string) => isSuperAdmin() && can(perm);

export async function renderPayroll(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const periods = await get<PayrollPeriod[]>('/api/payroll/periods');
    const act = async (p: PayrollPeriod, action: 'calculate' | 'approve' | 'publish' | 'reopen', label: string) => {
      const legacy = (action === 'calculate' || action === 'reopen') && p.legacy_slips > 0;
      const ok = action === 'reopen'
        ? await confirmDialog('เปิดแก้ไขงวด (กลับเป็นร่าง)', `สลิปที่คำนวณแล้ว ${p.employees} รายการ (ยอดสุทธิรวม ${fmtMoney(p.total_net)} บาท) จะถูกนำออกจากงวดนี้ และเก็บสำเนาไว้ในประวัติการคำนวณ${legacy ? ` — ในจำนวนนี้ ${p.legacy_slips} รายการคำนวณด้วยเวอร์ชันก่อนหน้า (Legacy) หากคำนวณใหม่ ยอดอาจเปลี่ยนตามกติกาปัจจุบัน` : ''} ยืนยันเปิดแก้ไข?`, 'ยืนยันเปิดแก้ไข', true)
        : legacy
        ? await confirmDialog('คำนวณงวด Legacy ใหม่', `งวด ${p.name} มีสลิป ${p.legacy_slips} รายการที่คำนวณด้วยเวอร์ชันก่อนหน้า (ยอดสุทธิรวมเดิม ${fmtMoney(p.total_net)} บาท) การคำนวณใหม่จะใช้กติกาปัจจุบัน (คิดตามวันมีสิทธิ์ แยกช่วงทดลองงาน ใช้ OT/ลาจาก Feishu ที่ยืนยันแล้ว) และยอดอาจเปลี่ยน สลิปเดิมจะถูกแทนที่ — แนะนำให้ Export ยอดเดิมเก็บไว้ก่อน ยืนยันคำนวณใหม่?`, 'ยืนยันคำนวณใหม่', true)
        : await confirmDialog(label, `${label} งวด ${p.name}?`, label);
      if (!ok) return;
      // a Super Admin approving a period they calculated adds an approval note (kept in the audit log)
      const selfApproval = action === 'approve' && p.calculated_by === state.meta?.me.id && isSuperAdmin();
      const note = selfApproval ? await promptDialog('อนุมัติงวดที่คุณคำนวณเอง (Super Admin)', 'บันทึกการอนุมัติ (เก็บไว้ใน Audit Log)', 'อนุมัติ') : null;
      if (selfApproval && !note) return;
      try {
        await post(`/api/payroll/periods/${p.id}/${action}`, legacy ? { confirm_legacy_recalculation: true } : note ? { note } : undefined);
        toast(`${label}เรียบร้อย`);
        void renderPayroll(main);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    };
    const reload = () => void renderPayroll(main);
    // a period a Super Admin reopened after closing is recalculated / reverted only by a Super Admin (reason + MFA)
    const forced = (p: PayrollPeriod) => !!p.reopened_from;
    mount(main,
      h('p', { class: 'muted lead' }, 'ขั้นตอน: สร้างงวด → คำนวณ → Preview → อนุมัติ (ผู้อนุมัติต้องไม่ใช่ผู้คำนวณ) → เผยแพร่สลิปให้พนักงาน · พนักงานทดลองงานจ่าย 2 รอบ: กลางเดือน (26–10, จ่ายไม่เกินวันที่ 15) และสิ้นเดือน (หักยอดจ่ายกลางเดือน)'),
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }),
        adminCan(PERIOD_ADMIN.delete) ? h('button', { class: 'btn', onclick: () => void deletedPeriods(reload) }, 'งวดที่ลบแล้ว') : null,
        can('payroll.calculate') ? h('button', { class: 'btn primary', onclick: () => newPeriod(reload) }, '+ สร้างงวด') : null),
      periods.length
        ? h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['รหัส', 'ชื่องวด', 'รอบ', 'บริษัท', 'ช่วงวันที่', 'วันจ่าย', 'สถานะ', 'จำนวนคน', 'ยอดสุทธิรวม', 'EWF นายจ้างสมทบ', ''].map((t) => h('th', null, t)))),
            h('tbody', null, periods.map((p) => h('tr', null,
              h('td', null, p.code), h('td', null, p.name), h('td', null, optionLabel(p.kind)), h('td', null, p.company ?? 'ทุกบริษัท'), h('td', null, `${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}`), h('td', null, fmtDate(p.pay_date)),
              h('td', null, h('span', { class: `badge-status s-${p.status}` }, optionLabel(p.status)), p.legacy_slips ? h('span', { class: 'badge-status s-pending', title: 'คำนวณด้วยเวอร์ชันก่อน Migration 0005' }, ' Legacy') : null,
                p.reopened_from ? h('span', { class: 'badge-status s-pending', title: `Super Admin เปิดงวดหลังปิด (เดิม: ${optionLabel(p.reopened_from)}) — คำนวณใหม่/เปิดแก้ไขได้เฉพาะ Super Admin จนกว่าจะอนุมัติอีกครั้ง` }, ' เปิดโดย Super Admin') : null),
              h('td', null, String(p.employees)), h('td', null, fmtMoney(p.total_net)), h('td', null, fmtMoney(p.total_ewf_employer)),
              h('td', { class: 'actions' },
                (p.status === 'draft' || p.status === 'calculated') && !forced(p) && can('payroll.calculate') ? h('button', { class: 'btn small', onclick: () => void act(p, 'calculate', 'คำนวณ') }, p.status === 'draft' ? 'คำนวณ' : 'คำนวณใหม่') : null,
                p.status === 'calculated' && !forced(p) && can('payroll.calculate') ? h('button', { class: 'btn small', onclick: () => void act(p, 'reopen', 'เปิดแก้ไข (กลับเป็นร่าง)') }, 'เปิดแก้ไข') : null,
                (p.status === 'draft' || p.status === 'calculated') && forced(p) && adminCan(PERIOD_ADMIN.forceRecalculate) ? h('button', { class: 'btn small', onclick: () => void adminDialog(p, 'calculate', reload) }, 'คำนวณใหม่ (Super Admin)') : null,
                p.status === 'calculated' && forced(p) && adminCan(PERIOD_ADMIN.forceRecalculate) ? h('button', { class: 'btn small', onclick: () => void adminDialog(p, 'revert', reload) }, 'เปิดแก้ไข (Super Admin)') : null,
                p.status === 'calculated' && can('payroll.approve') ? h('button', { class: 'btn small primary', onclick: () => void act(p, 'approve', 'อนุมัติ') }, 'อนุมัติ') : null,
                can('payroll_preview.view') ? link(`/payroll/preview?period_id=${p.id}`, 'Preview', { class: 'btn small' }) : null,
                p.status === 'approved' && can('payroll.publish') ? h('button', { class: 'btn small primary', onclick: () => void act(p, 'publish', 'เผยแพร่') }, 'เผยแพร่') : null,
                p.employees ? link(`/payroll/payslips?period_id=${p.id}`, 'ดูสลิป', { class: 'btn small' }) : null,
                p.employees && can('payroll.export') ? h('a', { class: 'btn small', href: `${basePath()}/api/payroll/periods/${p.id}/export.csv`, download: true }, 'Export') : null,
                (p.status === 'approved' || p.status === 'published') && adminCan(PERIOD_ADMIN.reopen) ? h('button', { class: 'btn small', onclick: () => void adminDialog(p, 'reopen', reload) }, 'เปิดงวดที่ปิดแล้ว') : null,
                adminCan(PERIOD_ADMIN.edit) ? h('button', { class: 'btn small', onclick: () => void adminDialog(p, 'edit', reload) }, 'แก้ไขงวด') : null,
                adminCan(PERIOD_ADMIN.delete) ? h('button', { class: 'btn small danger', onclick: () => void adminDialog(p, 'delete', reload) }, 'ลบงวด') : null)))))
        : h('div', { class: 'empty' }, 'ยังไม่มีงวดเงินเดือน'),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

type AdminMode = 'reopen' | 'edit' | 'delete' | 'calculate' | 'revert';

const ADMIN_TEXT: Record<AdminMode, { title: string; button: string; warning: (p: PayrollPeriod, i: PeriodImpact) => string; typeCode: boolean }> = {
  reopen: {
    title: 'เปิดงวดที่ปิดแล้ว (Super Admin)',
    button: 'ยืนยันเปิดงวด',
    typeCode: true,
    warning: (p, i) => `สถานะจะเปลี่ยนจาก "${optionLabel(p.status)}" เป็น "คำนวณแล้ว" · สลิป ${i.payslips.count} รายการถูกเก็บสำเนาใน Archive ก่อน${i.payslips.published ? ` และยกเลิกการเผยแพร่ ${i.payslips.published} รายการ (พนักงานจะไม่เห็นสลิปและยอดสะสม YTD ของงวดนี้จนกว่าจะเผยแพร่ใหม่)` : ''} · ระบบไม่คำนวณใหม่และไม่เผยแพร่อัตโนมัติ การคำนวณใหม่ต้องทำแยก (Super Admin) และต้องอนุมัติใหม่`,
  },
  edit: {
    title: 'แก้ไขข้อมูลงวด (Super Admin)',
    button: 'บันทึกการแก้ไข',
    typeCode: false,
    warning: () => 'การแก้ไขไม่คำนวณใหม่และไม่เปลี่ยนสลิปหรือ Snapshot ที่มีอยู่ · งวดที่มีสลิปแก้ได้เฉพาะชื่อและรหัสงวด',
  },
  delete: {
    title: 'ลบงวดเงินเดือน (Super Admin)',
    button: 'ยืนยันลบงวด',
    typeCode: true,
    warning: () => 'ลบแบบกู้คืนได้ (Soft delete): งวดจะหายจากรายการและการคำนวณ แต่ประวัติ Archive และ Audit ยังอยู่ครบ กู้คืนได้จาก "งวดที่ลบแล้ว" · ไม่ลบพนักงาน ข้อมูลเวลาทำงาน ประวัติเงินเดือน หรืองวดอื่น',
  },
  calculate: {
    title: 'คำนวณงวดใหม่หลังเปิดงวด (Super Admin)',
    button: 'ยืนยันคำนวณใหม่',
    typeCode: false,
    warning: (p, i) => `คำนวณด้วยกติกาและข้อมูลปัจจุบัน ยอดอาจต่างจากเดิม · สลิปปัจจุบัน ${i.payslips.count} รายการ (สุทธิ ${fmtMoney(i.payslips.net)}) ถูกเก็บใน Archive ก่อนแทนที่${p.legacy_slips ? ` · มีสลิป Legacy ${p.legacy_slips} รายการ ต้องยืนยันแยก` : ''}`,
  },
  revert: {
    title: 'เปิดแก้ไขกลับเป็นร่าง (Super Admin)',
    button: 'ยืนยันเปิดแก้ไข',
    typeCode: false,
    warning: (_p, i) => `สลิป ${i.payslips.count} รายการ (สุทธิ ${fmtMoney(i.payslips.net)}) ถูกเก็บใน Archive แล้วนำออกจากงวด และปลดล็อกข้อมูลเวลาทำงาน`,
  },
};

function impactSummary(i: PeriodImpact): HTMLElement {
  const row = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];
  return h('dl', { class: 'dl' },
    row('สถานะ', `${optionLabel(i.approval.status)}${i.approval.everPublished && i.approval.status !== 'published' ? ' · เคยเผยแพร่แล้ว' : ''}${i.approval.approvedAt ? ` · อนุมัติ ${fmtDate(i.approval.approvedAt)}` : ''}${i.approval.publishedAt ? ` · เผยแพร่ ${fmtDate(i.approval.publishedAt)}` : ''}`),
    row('สลิปที่ได้รับผลกระทบ', `${i.payslips.count} รายการ (เผยแพร่ ${i.payslips.published})`),
    row('รวมเงินได้ / สุทธิ', `${fmtMoney(i.payslips.gross)} / ${fmtMoney(i.payslips.net)} บาท`),
    row('หักเงินจ่ายกลางเดือนในงวดนี้', i.payslips.withAdvance ? `${i.payslips.withAdvance} คน · ${fmtMoney(i.payslips.advance)} บาท` : '-'),
    row('Archive (ประวัติสลิป)', `${i.archive.count} แถว · ${i.archive.versions} เวอร์ชัน`),
    row('ข้อมูลเวลาทำงาน (Feishu)', `ใช้งาน ${i.attendance.active} · ล็อก ${i.attendance.locked} · ทั้งหมด ${i.attendance.total}`),
    row('งวดที่เกี่ยวข้อง', i.dependencies.length
      ? i.dependencies.map((d) => `${d.relation === 'month_end' ? 'งวดสิ้นเดือน' : 'รอบกลางเดือน'} ${d.code} (${optionLabel(d.status)}${d.advance ? `, ${d.relation === 'month_end' ? 'หักคืน' : 'จ่าย'} ${fmtMoney(d.advance)}` : ''})`).join(' · ')
      : '-'));
}

async function adminDialog(p: PayrollPeriod, mode: AdminMode, onDone: () => void): Promise<void> {
  let impact: PeriodImpact;
  try {
    impact = await get<PeriodImpact>(`/api/payroll/periods/${p.id}/impact`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  const text = ADMIN_TEXT[mode];
  const blockers = mode === 'reopen' ? impact.blockers.reopen : mode === 'delete' ? impact.blockers.delete : [];
  const calcLocked = impact.blockers.editCalculation.length > 0;
  const reason = h('textarea', { rows: 2, maxlength: 500, required: true, placeholder: 'เหตุผล (บันทึกใน Audit Log)' });
  const confirmInput = h('input', { autocomplete: 'off' });
  const totp = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000' });
  const legacy = h('input', { type: 'checkbox' });
  const companies = state.meta?.companies.items ?? [];
  const f = {
    name: h('input', { value: p.name, maxlength: 100 }),
    code: h('input', { value: p.code, maxlength: 20 }),
    start_date: h('input', { type: 'date', value: p.start_date, disabled: calcLocked }),
    end_date: h('input', { type: 'date', value: p.end_date, disabled: calcLocked }),
    pay_date: h('input', { type: 'date', value: p.pay_date, disabled: calcLocked }),
    company_id: h('select', { disabled: calcLocked }, h('option', { value: '', selected: p.company_id === null }, 'ทุกบริษัท'), companies.map((c) => h('option', { value: String(c.id), selected: c.id === p.company_id }, c.name))),
  };
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const field = (label: string, el: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), el);
  const submit = h('button', { class: `btn ${mode === 'edit' ? 'primary' : 'danger'}`, disabled: blockers.length > 0, onclick: async () => {
    msg.textContent = '';
    const base = { reason: reason.value.trim(), totp: totp.value.trim() };
    try {
      if (mode === 'reopen') await post(`/api/payroll/periods/${p.id}/reopen-closed`, { ...base, confirm_code: confirmInput.value.trim() });
      else if (mode === 'delete') await post(`/api/payroll/periods/${p.id}/delete`, { ...base, confirm_code: confirmInput.value.trim() });
      else if (mode === 'calculate') await post(`/api/payroll/periods/${p.id}/calculate`, { ...base, confirm_legacy_recalculation: legacy.checked });
      else if (mode === 'revert') await post(`/api/payroll/periods/${p.id}/reopen`, { ...base, confirm_legacy_recalculation: legacy.checked });
      else {
        const body: Record<string, unknown> = { ...base, name: f.name.value.trim(), code: f.code.value.trim() };
        if (!calcLocked) Object.assign(body, { start_date: f.start_date.value, end_date: f.end_date.value, pay_date: f.pay_date.value, company_id: f.company_id.value || null });
        await put(`/api/payroll/periods/${p.id}`, body);
      }
      dlg.close();
      toast(`${text.button}เรียบร้อย`);
      onDone();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  } }, text.button);
  const dlg = modal(text.title, h('div', null,
    h('p', null, h('strong', null, `${p.code} · ${p.name}`)),
    impactSummary(impact),
    blockers.length ? h('div', { class: 'alert alert-error' }, h('strong', null, 'ดำเนินการไม่ได้: '), blockers.join(' · ')) : null,
    h('div', { class: 'alert' }, text.warning(p, impact)),
    mode === 'edit' && calcLocked ? h('div', { class: 'alert' }, impact.blockers.editCalculation.join(' · ')) : null,
    h('div', { class: 'grid-form' },
      mode === 'edit' ? [field('ชื่องวด', f.name), field('รหัสงวด', f.code), field('ตั้งแต่', f.start_date), field('ถึง', f.end_date), field('วันจ่าย', f.pay_date), field('บริษัท', f.company_id)] : null,
      field('เหตุผล *', reason),
      text.typeCode ? field(`พิมพ์รหัสงวด "${p.code}" เพื่อยืนยัน *`, confirmInput) : null,
      (mode === 'calculate' || mode === 'revert') && p.legacy_slips ? h('label', { class: 'field inline' }, legacy, h('span', null, `ยืนยันแทนที่สลิป Legacy ${p.legacy_slips} รายการ`)) : null,
      field('รหัส MFA (6 หลัก) *', totp)),
    msg), [h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'), submit]);
}

async function deletedPeriods(onDone: () => void): Promise<void> {
  let rows: DeletedPeriod[];
  try {
    rows = await get<DeletedPeriod[]>('/api/payroll/deleted-periods');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  const restore = (d: DeletedPeriod) => {
    const reason = h('textarea', { rows: 2, maxlength: 500 });
    const totp = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    const msg = h('div', { class: 'form-msg', role: 'alert' });
    const m = modal(`กู้คืนงวด ${d.code}`, h('div', { class: 'grid-form' },
      h('label', { class: 'field' }, h('span', null, 'เหตุผล *'), reason), h('label', { class: 'field' }, h('span', null, 'รหัส MFA (6 หลัก) *'), totp), msg), [
      h('button', { class: 'btn', onclick: () => m.close() }, 'ยกเลิก'),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await post(`/api/payroll/periods/${d.id}/restore`, { reason: reason.value.trim(), totp: totp.value.trim() });
          m.close();
          list.close();
          toast('กู้คืนงวดแล้ว');
          onDone();
        } catch (e) {
          msg.textContent = e instanceof Error ? e.message : String(e);
        }
      } }, 'กู้คืน'),
    ]);
  };
  const list = modal('งวดที่ลบแล้ว (กู้คืนได้)', rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
        h('thead', null, h('tr', null, ['รหัส', 'ชื่องวด', 'ช่วงวันที่', 'ลบเมื่อ', 'โดย', 'เหตุผล', 'Archive', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((d) => h('tr', null, h('td', null, d.code), h('td', null, d.name), h('td', null, `${fmtDate(d.start_date)} – ${fmtDate(d.end_date)}`), h('td', null, fmtDate(d.deleted_at)),
          h('td', null, d.deleted_by ?? '-'), h('td', null, d.delete_reason ?? '-'), h('td', null, String(d.archived)), h('td', null, h('button', { class: 'btn small', onclick: () => restore(d) }, 'กู้คืน')))))))
    : h('div', { class: 'empty' }, 'ไม่มีงวดที่ถูกลบ'));
}

function newPeriod(onDone: () => void): void {
  const now = new Date();
  const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const prev = m === 1 ? ym(y - 1, 12) : ym(y, m - 1);
  const cur = ym(y, m);
  const companies = state.meta?.companies.items ?? [];
  const company = h('select', null, state.meta?.companies.scope === 'all' ? h('option', { value: '' }, 'ทุกบริษัท') : null, companies.map((c) => h('option', { value: String(c.id), selected: c.id === state.companyId }, c.name)));
  const kind = h('select', { onchange: () => fill() }, h('option', { value: 'monthly' }, 'รายเดือน (สิ้นเดือน) 26 – 25'), h('option', { value: 'mid_month' }, 'กลางเดือน (พนักงานทดลองงาน) 26 – 10'));
  const code = h('input', { required: true, maxlength: 20 });
  const name = h('input', { required: true });
  const start = h('input', { type: 'date', required: true });
  const end = h('input', { type: 'date', required: true });
  const pay = h('input', { type: 'date', required: true });
  const fill = () => {
    const mid = kind.value === 'mid_month';
    code.value = mid ? `${cur}-M` : cur;
    name.value = `${mid ? 'จ่ายกลางเดือน' : 'เงินเดือน'} ${String(m).padStart(2, '0')}/${y + 543}`;
    start.value = `${prev}-26`;
    end.value = mid ? `${cur}-10` : `${cur}-25`;
    pay.value = mid ? `${cur}-15` : `${cur}-25`;
  };
  fill();
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal('สร้างงวดเงินเดือน', h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, h('span', null, 'ประเภทรอบ *'), kind),
    h('label', { class: 'field' }, h('span', null, 'บริษัท'), company),
    h('label', { class: 'field' }, h('span', null, 'รหัสงวด *'), code), h('label', { class: 'field' }, h('span', null, 'ชื่องวด *'), name),
    h('label', { class: 'field' }, h('span', null, 'ตั้งแต่ *'), start), h('label', { class: 'field' }, h('span', null, 'ถึง *'), end),
    h('label', { class: 'field' }, h('span', null, 'วันจ่าย *'), pay), msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post('/api/payroll/periods', { kind: kind.value, company_id: company.value || null, code: code.value, name: name.value, start_date: start.value, end_date: end.value, pay_date: pay.value });
        dlg.close();
        toast('สร้างงวดแล้ว');
        onDone();
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
    } }, 'สร้าง'),
  ]);
}

function slipTable(rows: PayslipSummary[], base: string): HTMLElement {
  return rows.length
    ? h('table', { class: 'table' }, h('thead', null, h('tr', null, ['งวด', 'พนักงาน', 'รวมเงินได้', 'รวมหัก', 'สุทธิ', 'สถานะ', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.period_name), h('td', null, r.employee), h('td', null, fmtMoney(r.gross)), h('td', null, fmtMoney(r.deductions)),
          h('td', null, h('strong', null, fmtMoney(r.net))), h('td', null, r.published ? 'เผยแพร่แล้ว' : 'ยังไม่เผยแพร่'), h('td', null, link(`${base}/${r.id}`, 'เปิดสลิป', { class: 'btn small' }))))))
    : h('div', { class: 'empty' }, 'ไม่มีสลิปเงินเดือน');
}

export async function renderPayslips(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const periods = await get<PayrollPeriod[]>('/api/payroll/periods');
    const pid = params.get('period_id') ?? (periods[0] ? String(periods[0].id) : '');
    const rows = pid ? await get<PayslipSummary[]>(`/api/payroll/payslips${qs({ period_id: pid })}`) : [];
    const sel = h('select', { onchange: () => { history.replaceState(null, '', `?period_id=${sel.value}`); void renderPayslips(main, new URLSearchParams({ period_id: sel.value })); } },
      periods.map((p) => h('option', { value: String(p.id), selected: String(p.id) === pid }, `${p.name} (${optionLabel(p.status)})`)));
    mount(main, h('div', { class: 'toolbar' }, h('label', { class: 'field inline' }, h('span', null, 'งวด'), sel)), slipTable(rows, '/payroll/payslips'));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderMyPayslips(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const d = await get<{ linked: boolean; rows: PayslipSummary[] }>('/api/my/payslips');
    mount(main, d.linked
      ? slipTable(d.rows, '/my/payslips')
      : h('div', { class: 'card' }, h('p', null, 'บัญชีนี้ยังไม่ได้ผูกกับข้อมูลพนักงาน จึงไม่มีสลิปเงินเดือนของตนเอง'), can('payroll.view') ? link('/payroll/payslips', 'ดูสลิปเงินเดือนของพนักงาน (HR)', { class: 'btn' }) : null));
  } catch (e) {
    mount(main, errorBox(e));
  }
}

export async function renderPayslipView(main: HTMLElement, id: number, back: string): Promise<void> {
  mount(main, loading());
  try {
    const s = await get<PayslipDetail>(`/api/payslips/${id}`);
    const earn = s.lines.filter((l) => l.kind === 'earning');
    const ded = s.lines.filter((l) => l.kind === 'deduction');
    const col = (title: string, lines: typeof s.lines, total: number) => h('div', null, h('h3', null, title),
      h('table', { class: 'table compact' }, h('tbody', null, lines.map((l) => h('tr', null, h('td', null, l.name), h('td', { class: 'num' }, fmtMoney(l.amount)))),
        h('tr', { class: 'total' }, h('td', null, 'รวม'), h('td', { class: 'num' }, fmtMoney(total))))));
    mount(main,
      h('div', { class: 'toolbar no-print' }, link(back, '‹ กลับ', { class: 'btn' }), h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => window.print() }, 'พิมพ์ / บันทึก PDF')),
      h('article', { class: 'card payslip' },
        h('header', null, h('h2', null, 'สลิปเงินเดือน'), h('div', { class: 'muted' }, `${s.period_name} · วันจ่าย ${fmtDate(s.pay_date)}`)),
        h('dl', { class: 'dl' }, h('dt', null, 'พนักงาน'), h('dd', null, s.employee), h('dt', null, 'บริษัท'), h('dd', null, s.company ?? '-'), h('dt', null, 'หน่วยงาน'), h('dd', null, s.calc?.department ?? s.department ?? '-'), h('dt', null, 'ตำแหน่ง'), h('dd', null, s.calc?.position ?? s.position ?? '-'),
          s.calc ? [h('dt', null, 'สถานะทดลองงาน'), h('dd', null, `${PROBATION_LABEL[s.calc.probationStatus] ?? s.calc.probationStatus} (ครบ 90 วัน ${fmtDate(s.calc.probationEnd)})`)] : null),
        s.period_kind === 'mid_month' ? h('div', { class: 'alert' }, 'รอบจ่ายกลางเดือน (ทดลองงาน): เป็นการจ่ายล่วงหน้าตามวันที่มีสิทธิ์ และจะถูกหักในงวดสิ้นเดือน (Mid-month Advance)') : null,
        s.calc && (s.calc.segments.length > 1 || !s.calc.fullPeriod) ? segmentTable(s.calc.segments) : null,
        h('div', { class: 'grid2' }, col('รายได้', earn, earn.reduce((a, l) => a + l.amount, 0)), col('รายการหัก', ded, s.deductions + s.unpaid_leave)),
        h('div', { class: 'net' }, 'เงินได้สุทธิ ', h('strong', null, `${fmtMoney(s.net)} บาท`)),
        // employer contribution is returned only to payroll staff; it is informational and never part of net pay
        s.ewf_employer !== undefined && s.ewf_employer > 0
          ? h('div', { class: 'alert employer-note no-print' }, `เงินสมทบกองทุนสงเคราะห์ลูกจ้างของนายจ้าง ${fmtMoney(s.ewf_employer)} บาท (อัตรา ${s.ewf_employer_rate ?? '-'}%) — ไม่หักจากเงินได้ของพนักงาน แสดงเฉพาะฝ่ายเงินเดือน`)
          : null,
        s.ytd ? ytdBlock(s.ytd) : null,
        s.published ? null : h('div', { class: 'alert' }, 'สลิปนี้ยังไม่ได้เผยแพร่ให้พนักงาน')),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

function segmentTable(segments: WageSegmentView[]): HTMLElement {
  return h('div', null, h('h3', null, 'ค่าจ้างตามช่วงเวลา (ฐาน 30 วัน)'),
    h('table', { class: 'table compact' },
      h('thead', null, h('tr', null, ['ช่วง', 'สถานะ', 'วันตามปฏิทิน', 'วันที่คิดค่าจ้าง', 'อัตรา/เดือน', 'จำนวนเงิน'].map((t) => h('th', null, t)))),
      h('tbody', null, segments.map((g) => h('tr', null, h('td', null, `${fmtDate(g.start)} – ${fmtDate(g.end)}`), h('td', null, g.status === 'probation' ? 'ทดลองงาน' : 'ผ่านทดลองงาน'),
        h('td', { class: 'num' }, String(g.days)), h('td', { class: 'num' }, String(g.paidDays)), h('td', { class: 'num' }, fmtMoney(g.rate)), h('td', { class: 'num' }, fmtMoney(g.amount)))),
        h('tr', { class: 'total' }, h('td', { colspan: 5 }, 'รวมค่าจ้าง'), h('td', { class: 'num' }, fmtMoney(segments.reduce((a, g) => a + g.amount, 0)))))));
}

function ytdBlock(y: PayslipYtd): HTMLElement {
  const row = (label: string, t: { gross: number; sso: number; tax: number; ewf_employee: number }) =>
    h('tr', null, h('td', null, label), h('td', { class: 'num' }, fmtMoney(t.gross)), h('td', { class: 'num' }, fmtMoney(t.sso)), h('td', { class: 'num' }, fmtMoney(t.tax)), h('td', { class: 'num' }, fmtMoney(t.ewf_employee)));
  const multi = y.employee.companies > 1 || y.byCompany.some((c) => c.company_id !== y.company.company_id);
  return h('section', { class: 'ytd' }, h('h3', null, `ยอดสะสมตั้งแต่ต้นปี ${y.year + 543} (YTD)`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
      h('thead', null, h('tr', null, ['', 'เงินได้สะสม', 'ประกันสังคมสะสม', 'ภาษีสะสม', 'กองทุนสงเคราะห์ลูกจ้างสะสม (พนักงาน)'].map((t) => h('th', null, t)))),
      h('tbody', null,
        row(`บริษัทนี้${y.company.company ? ` (${y.company.company})` : ''}`, y.company),
        multi ? y.byCompany.filter((c) => c.company_id !== y.company.company_id).map((c) => row(c.company ?? 'บริษัทอื่น', c)) : null,
        h('tr', { class: 'total' }, h('td', null, multi ? 'รวมทุกบริษัท (ตัวพนักงาน)' : 'รวม'), h('td', { class: 'num' }, fmtMoney(y.employee.gross)), h('td', { class: 'num' }, fmtMoney(y.employee.sso)), h('td', { class: 'num' }, fmtMoney(y.employee.tax)), h('td', { class: 'num' }, fmtMoney(y.employee.ewf_employee)))))),
    h('p', { class: 'muted small' }, `นับเฉพาะสลิปที่เผยแพร่แล้วตั้งแต่ 1 ม.ค. ถึงงวดนี้ (ไม่รวมรอบจ่ายกลางเดือนซึ่งรวมอยู่ในงวดสิ้นเดือนแล้ว และไม่รวมเงินสมทบของนายจ้าง)${y.includesCurrent ? '' : ' · สลิปนี้ยังไม่เผยแพร่ จึงยังไม่ถูกนับ'}`));
}
