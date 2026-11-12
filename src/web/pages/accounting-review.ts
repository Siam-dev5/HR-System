import { get, post } from '../api';
import { h, mount, loading, errorBox, fmtMoney, toast, promptDialog, confirmDialog } from '../dom';
import { can, link } from '../app';

interface AccountingPeriod {
  id: number; code: string; name: string; company_id: number | null; period_status: string;
  calc_version: number; approved_at: string | null; accounting_status: 'reviewed' | 'returned' | 'signed_off' | null;
  staff_reviewed_by: number | null; staff_reviewed_at: string | null; staff_note: string | null;
  manager_signed_by: number | null; manager_signed_at: string | null; manager_note: string | null;
  employees: number; total_net: number;
}

const statusText: Record<string, string> = {
  reviewed: 'ACC Staff ตรวจแล้ว · รอ ACC Manager',
  returned: 'ส่งกลับ HR · ต้องคำนวณใหม่',
  signed_off: 'ACC Manager ลงนามแล้ว',
};

export async function renderAccountingReview(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const rows = await get<AccountingPeriod[]>('/api/payroll/accounting/periods');
    const reload = () => void renderAccountingReview(main);
    const review = async (p: AccountingPeriod) => {
      const note = await promptDialog('บันทึกผลตรวจสอบ ACC Staff', `งวด ${p.code} · Version ${p.calc_version}\nระบุหมายเหตุหรือข้อสังเกต (เว้นว่างได้)`, 'บันทึกผลตรวจ');
      if (note === null) return;
      try { await post(`/api/payroll/periods/${p.id}/accounting-review`, { note }); toast('บันทึกผลตรวจสอบแล้ว'); reload(); }
      catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    };
    const signoff = async (p: AccountingPeriod) => {
      const decision = await confirmDialog('ACC Manager ลงนามรับรอง', `ยืนยันรับรองงวด ${p.code} · Calculation Version ${p.calc_version} หรือไม่? การลงนามจะอนุญาตให้ Payroll Officer เผยแพร่สลิปได้`, 'ลงนามรับรอง');
      if (decision) {
        try { await post(`/api/payroll/periods/${p.id}/accounting-signoff`, { decision: 'signed_off' }); toast('ลงนามรับรองแล้ว'); reload(); }
        catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
      }
    };
    const returnToHr = async (p: AccountingPeriod) => {
      const note = await promptDialog('ส่งกลับให้ HR แก้ไข', `งวด ${p.code} · Version ${p.calc_version}\nระบุสาเหตุที่ต้องแก้ไข (อย่างน้อย 5 ตัวอักษร)`, 'ส่งกลับ HR');
      if (!note || note.trim().length < 5) return;
      try { await post(`/api/payroll/periods/${p.id}/accounting-signoff`, { decision: 'returned', note }); toast('ส่งกลับ HR แล้ว'); reload(); }
      catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    };
    mount(main,
      h('p', { class: 'muted lead' }, 'ขั้นตอนควบคุม: HR คำนวณและอนุมัติ → ACC Staff ตรวจสอบ → ACC Manager ลงนาม → Payroll Officer เผยแพร่สลิป · การคำนวณใหม่จะยกเลิกผลตรวจและลายเซ็นของ Version เดิมโดยอัตโนมัติ'),
      rows.length ? h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['งวดเงินเดือน', 'สถานะ HR', 'Version', 'พนักงาน', 'ยอดสุทธิ', 'สถานะ ACC', 'การดำเนินการ'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((p) => h('tr', null,
          h('td', null, h('strong', null, p.code), h('div', { class: 'muted small' }, p.name)),
          h('td', null, p.period_status === 'published' ? 'เผยแพร่แล้ว' : 'HR อนุมัติแล้ว'),
          h('td', null, String(p.calc_version)),
          h('td', null, String(p.employees)),
          h('td', null, fmtMoney(p.total_net)),
          h('td', null, statusText[p.accounting_status ?? ''] ?? 'รอ ACC Staff ตรวจสอบ'),
          h('td', { class: 'actions' },
            link(`/payroll/preview?period_id=${p.id}`, 'เปิด Preview', { class: 'btn small' }),
            p.period_status === 'approved' && !p.accounting_status && can('payroll.accounting.review.submit') ? h('button', { class: 'btn small primary', onclick: () => void review(p) }, 'บันทึกผลตรวจ') : null,
            p.accounting_status === 'reviewed' && can('payroll.accounting.signoff') ? h('button', { class: 'btn small primary', onclick: () => void signoff(p) }, 'ลงนามรับรอง') : null,
            p.accounting_status === 'reviewed' && can('payroll.accounting.signoff') ? h('button', { class: 'btn small danger', onclick: () => void returnToHr(p) }, 'ส่งกลับ HR') : null,
          ),
        ))),
      ) : h('div', { class: 'empty' }, 'ยังไม่มีงวดที่ HR อนุมัติและรอการตรวจสอบจากฝ่ายบัญชี'),
    );
  } catch (e) { mount(main, errorBox(e)); }
}
