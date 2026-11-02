import type { PayrollPeriod, PayslipDetail, PayslipSummary } from '../../shared/types';
import { get, post, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtMoney, modal, toast, confirmDialog } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, link } from '../app';

export async function renderPayroll(main: HTMLElement): Promise<void> {
  mount(main, loading());
  try {
    const periods = await get<PayrollPeriod[]>('/api/payroll/periods');
    const act = async (p: PayrollPeriod, action: 'calculate' | 'approve' | 'publish', label: string) => {
      if (!(await confirmDialog(label, `${label} งวด ${p.name}?`, label))) return;
      try {
        await post(`/api/payroll/periods/${p.id}/${action}`);
        toast(`${label}เรียบร้อย`);
        void renderPayroll(main);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    };
    mount(main,
      h('p', { class: 'muted lead' }, 'ขั้นตอน: สร้างงวด → คำนวณ → อนุมัติ (ผู้อนุมัติต้องไม่ใช่ผู้คำนวณ) → เผยแพร่สลิปให้พนักงาน'),
      h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }),
        can('payroll.calculate') ? h('button', { class: 'btn primary', onclick: () => newPeriod(() => void renderPayroll(main)) }, '+ สร้างงวด') : null),
      periods.length
        ? h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['รหัส', 'ชื่องวด', 'ช่วงวันที่', 'วันจ่าย', 'สถานะ', 'จำนวนคน', 'ยอดสุทธิรวม', 'EWF นายจ้างสมทบ', ''].map((t) => h('th', null, t)))),
            h('tbody', null, periods.map((p) => h('tr', null,
              h('td', null, p.code), h('td', null, p.name), h('td', null, `${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}`), h('td', null, fmtDate(p.pay_date)),
              h('td', null, h('span', { class: `badge-status s-${p.status}` }, optionLabel(p.status))), h('td', null, String(p.employees)), h('td', null, fmtMoney(p.total_net)), h('td', null, fmtMoney(p.total_ewf_employer)),
              h('td', { class: 'actions' },
                (p.status === 'draft' || p.status === 'calculated') && can('payroll.calculate') ? h('button', { class: 'btn small', onclick: () => void act(p, 'calculate', 'คำนวณ') }, p.status === 'draft' ? 'คำนวณ' : 'คำนวณใหม่') : null,
                p.status === 'calculated' && can('payroll.approve') ? h('button', { class: 'btn small primary', onclick: () => void act(p, 'approve', 'อนุมัติ') }, 'อนุมัติ') : null,
                p.status === 'approved' && can('payroll.publish') ? h('button', { class: 'btn small primary', onclick: () => void act(p, 'publish', 'เผยแพร่') }, 'เผยแพร่') : null,
                p.employees ? link(`/payroll/payslips?period_id=${p.id}`, 'ดูสลิป', { class: 'btn small' }) : null,
                p.employees && can('payroll.export') ? h('a', { class: 'btn small', href: `${basePath()}/api/payroll/periods/${p.id}/export.csv`, download: true }, 'Export') : null)))))
        : h('div', { class: 'empty' }, 'ยังไม่มีงวดเงินเดือน'),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

function newPeriod(onDone: () => void): void {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  const code = h('input', { value: `${y}-${mo}`, required: true, maxlength: 20 });
  const name = h('input', { value: `เงินเดือน ${mo}/${y + 543}`, required: true });
  const start = h('input', { type: 'date', value: `${y}-${mo}-01`, required: true });
  const end = h('input', { type: 'date', value: `${y}-${mo}-${last}`, required: true });
  const pay = h('input', { type: 'date', value: `${y}-${mo}-${last}`, required: true });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal('สร้างงวดเงินเดือน', h('div', { class: 'grid-form' },
    h('label', { class: 'field' }, h('span', null, 'รหัสงวด *'), code), h('label', { class: 'field' }, h('span', null, 'ชื่องวด *'), name),
    h('label', { class: 'field' }, h('span', null, 'ตั้งแต่ *'), start), h('label', { class: 'field' }, h('span', null, 'ถึง *'), end),
    h('label', { class: 'field' }, h('span', null, 'วันจ่าย *'), pay), msg), [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await post('/api/payroll/periods', { code: code.value, name: name.value, start_date: start.value, end_date: end.value, pay_date: pay.value });
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
        h('dl', { class: 'dl' }, h('dt', null, 'พนักงาน'), h('dd', null, s.employee), h('dt', null, 'หน่วยงาน'), h('dd', null, s.department ?? '-'), h('dt', null, 'ตำแหน่ง'), h('dd', null, s.position ?? '-')),
        h('div', { class: 'grid2' }, col('รายได้', earn, earn.reduce((a, l) => a + l.amount, 0)), col('รายการหัก', ded, s.deductions + s.unpaid_leave)),
        h('div', { class: 'net' }, 'เงินได้สุทธิ ', h('strong', null, `${fmtMoney(s.net)} บาท`)),
        // employer contribution is returned only to payroll staff; it is informational and never part of net pay
        s.ewf_employer !== undefined && s.ewf_employer > 0
          ? h('div', { class: 'alert employer-note no-print' }, `เงินสมทบกองทุนสงเคราะห์ลูกจ้างของนายจ้าง ${fmtMoney(s.ewf_employer)} บาท (อัตรา ${s.ewf_employer_rate ?? '-'}%) — ไม่หักจากเงินได้ของพนักงาน แสดงเฉพาะฝ่ายเงินเดือน`)
          : null,
        s.published ? null : h('div', { class: 'alert' }, 'สลิปนี้ยังไม่ได้เผยแพร่ให้พนักงาน')),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}
