// Payroll Preview: per-company column layout (Super Admin only: drag & drop, show / hide, save, reset),
// validation issues, and Preview-before-Export (CSV / Excel that match the previewed columns exactly).
import type { PayrollPeriod, PayrollPreviewResponse } from '../../shared/types';
import { PREVIEW_GROUPS, type LayoutColumn, type PreviewGroup } from '../../shared/payroll-columns';
import { get, put, del, qs } from '../api';
import { h, mount, loading, errorBox, fmtDate, fmtMoney, modal, toast, confirmDialog } from '../dom';
import { optionLabel } from '../labels';
import { basePath, can, isSuperAdmin, state } from '../app';
import { previewTable } from './payroll-preview-table';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function renderPayrollPreview(main: HTMLElement, params: URLSearchParams): Promise<void> {
  mount(main, loading());
  try {
    const periods = await get<PayrollPeriod[]>('/api/payroll/periods');
    if (!periods.length) return mount(main, h('div', { class: 'empty' }, 'ยังไม่มีงวดเงินเดือน'));
    const pid = params.get('period_id') ?? String(periods[0]?.id);
    const companies = state.meta?.companies.items ?? [];
    const company = params.has('company') ? params.get('company') || null : state.companyId !== null ? String(state.companyId) : null;
    const d = await get<PayrollPreviewResponse>(`/api/payroll/periods/${pid}/preview${qs({ company })}`);
    const go = (next: Record<string, string | null>) => {
      const p = new URLSearchParams({ period_id: pid, ...(company ? { company } : {}) });
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '') p.delete(k);
        else p.set(k, v);
      }
      if (next.company === '') p.set('company', '');
      history.replaceState(null, '', `?${p}`);
      void renderPayrollPreview(main, p);
    };
    const periodSel = h('select', { 'aria-label': 'งวด', onchange: () => go({ period_id: periodSel.value }) },
      periods.map((p) => h('option', { value: String(p.id), selected: String(p.id) === pid }, `${p.code} · ${p.name} · ${optionLabel(p.kind)} · ${optionLabel(p.status)}`)));
    const companySel = h('select', { 'aria-label': 'บริษัท', onchange: () => go({ company: companySel.value }) },
      state.meta?.companies.scope === 'all' ? h('option', { value: '', selected: !company }, 'ทุกบริษัท') : null,
      companies.map((c) => h('option', { value: String(c.id), selected: String(c.id) === company }, c.name)));

    const visible = d.layout.filter((l) => l.visible).map((l) => d.columns.find((c) => c.key === l.key)).filter((c): c is PayrollPreviewResponse['columns'][number] => !!c);
    const errors = d.issues.filter((i) => i.level === 'error');
    const t = d.totals;
    const kpi = (label: string, value: string) => h('div', { class: 'card kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value));

    const exportDialog = () => {
      const href = (ext: string) => `${basePath()}/api/payroll/periods/${pid}/preview.${ext}${qs({ company })}`;
      modal('ตรวจสอบก่อน Export', h('div', { class: 'stack' },
        h('dl', { class: 'dl' },
          h('dt', null, 'งวด'), h('dd', null, `${d.period.code} · ${d.period.name}`),
          h('dt', null, 'บริษัท'), h('dd', null, d.company?.name ?? 'ทุกบริษัท'),
          h('dt', null, 'จำนวนพนักงาน'), h('dd', null, String(d.rows.length)),
          h('dt', null, 'คอลัมน์ที่ Export'), h('dd', null, `${visible.length} คอลัมน์ (ตาม Layout ที่แสดงอยู่)`),
          h('dt', null, 'รวมเงินได้'), h('dd', null, fmtMoney(t.total_income)),
          h('dt', null, 'รวมเงินหัก'), h('dd', null, fmtMoney(t.total_deduction)),
          h('dt', null, 'เงินได้สุทธิรวม'), h('dd', null, fmtMoney(t.net_pay))),
        errors.length
          ? h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, 'ยัง Export ไม่ได้:'), h('ul', null, errors.map((i) => h('li', null, `${i.message} (${i.count})`))))
          : h('div', { class: 'alert' }, 'ข้อมูลผ่านการตรวจสอบแล้ว ไฟล์ที่ได้จะตรงกับตาราง Preview')),
      d.exportable
        ? [h('a', { class: 'btn', href: href('csv'), download: true }, 'ดาวน์โหลด CSV'), h('a', { class: 'btn primary', href: href('xlsx'), download: true }, 'ดาวน์โหลด Excel')]
        : null);
    };

    // frozen selection / code / name columns, search and selection (payroll-preview-table.ts)
    const table = d.rows.length ? await previewTable(d, pid, visible, () => go({})) : null;
    mount(main,
      h('div', { class: 'toolbar' },
        h('label', { class: 'field inline' }, h('span', null, 'งวด'), periodSel),
        companies.length ? h('label', { class: 'field inline' }, h('span', null, 'บริษัท'), companySel) : null,
        h('div', { class: 'spacer' }),
        d.canManageLayout && isSuperAdmin() ? h('button', { class: 'btn', onclick: () => layoutEditor(d, () => go({})) }, '⚙ จัดคอลัมน์ของบริษัทนี้') : null,
        can('payroll_preview.export') ? h('button', { class: 'btn primary', onclick: exportDialog }, 'Preview ก่อน Export') : null),
      h('p', { class: 'muted' },
        `${optionLabel(d.period.kind)} · ${fmtDate(d.period.start_date)} – ${fmtDate(d.period.end_date)} · วันจ่าย ${fmtDate(d.period.pay_date)} · `,
        d.source === 'live' ? h('strong', null, 'คำนวณชั่วคราว (ยังไม่บันทึก)') : `ข้อมูลจากการคำนวณครั้งที่ ${d.period.calc_version}`,
        d.layoutSaved ? ' · ใช้ Layout ของบริษัท' : ' · Layout มาตรฐาน',
        isSuperAdmin() && !d.company ? ' · เลือกบริษัทเพื่อจัดคอลัมน์' : null),
      d.issues.map((i) => h('div', { class: `alert ${i.level === 'error' ? 'alert-error' : ''}` }, `${i.level === 'error' ? '⛔' : '⚠'} ${i.message}${i.count > 1 ? ` (${i.count})` : ''}`)),
      h('div', { class: 'kpis' }, kpi('พนักงาน', String(d.rows.length)), kpi('รวมเงินได้', fmtMoney(t.total_income)), kpi('รวมเงินหัก', fmtMoney(t.total_deduction)), kpi('เงินได้สุทธิ', fmtMoney(t.net_pay)), kpi('EWF นายจ้างสมทบ', fmtMoney(t.ewf_employer))),
      table ?? h('div', { class: 'empty' }, 'ไม่มีพนักงานในงวด / บริษัทนี้'),
    );
  } catch (e) {
    mount(main, errorBox(e));
  }
}

/** Super Admin column editor: drag & drop (mouse) plus ↑ / ↓ buttons (keyboard), checkbox show / hide. */
function layoutEditor(d: PayrollPreviewResponse, onDone: () => void): void {
  if (!d.company) return;
  const companyId = d.company.id;
  const cols: LayoutColumn[] = d.layout.map((l) => ({ ...l }));
  const list = h('ol', { class: 'layout-list', 'aria-label': 'ลำดับคอลัมน์' });
  let dragFrom = -1;
  const label = (key: string) => d.columns.find((c) => c.key === key);
  const draw = (focusKey?: string) => {
    mount(list, cols.map((c, i) => {
      const col = label(c.key);
      const move = (to: number) => {
        if (to < 0 || to >= cols.length) return;
        const [x] = cols.splice(i, 1);
        cols.splice(to, 0, x as LayoutColumn);
        draw(c.key);
      };
      return h('li', {
        class: 'layout-item', draggable: 'true', 'data-key': c.key,
        ondragstart: (e: DragEvent) => { dragFrom = i; e.dataTransfer?.setData('text/plain', c.key); (e.currentTarget as HTMLElement).classList.add('dragging'); },
        ondragend: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('dragging'),
        ondragover: (e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drop-target'); },
        ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-target'),
        ondrop: (e: DragEvent) => {
          e.preventDefault();
          const key = e.dataTransfer?.getData('text/plain');
          const from = key ? cols.findIndex((x) => x.key === key) : dragFrom;
          if (from < 0 || from === i) return draw();
          const [x] = cols.splice(from, 1);
          cols.splice(i, 0, x as LayoutColumn);
          dragFrom = -1;
          draw();
        },
      },
        h('span', { class: 'drag-handle', 'aria-hidden': 'true' }, '⠿'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.visible, onchange: (e: Event) => { c.visible = (e.target as HTMLInputElement).checked; } }), ` ${col?.label ?? c.key}`),
        h('span', { class: 'muted small' }, PREVIEW_GROUPS[(col?.group ?? 'summary') as PreviewGroup]),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', 'aria-label': `เลื่อน ${col?.label} ขึ้น`, 'data-up': c.key, disabled: i === 0, onclick: () => move(i - 1) }, '↑'),
        h('button', { class: 'icon-btn', 'aria-label': `เลื่อน ${col?.label} ลง`, 'data-down': c.key, disabled: i === cols.length - 1, onclick: () => move(i + 1) }, '↓'));
    }));
    if (focusKey) (list.querySelector(`[data-key="${focusKey}"] .icon-btn:not([disabled])`) as HTMLElement | null)?.focus();
  };
  draw();
  const err = h('div', { class: 'form-msg', role: 'alert' });
  const dlg = modal(`จัดคอลัมน์ Payroll Preview · ${d.company.name}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'ลากเพื่อจัดลำดับ หรือใช้ปุ่ม ↑ ↓ · ติ๊กเพื่อแสดง/ซ่อน · Layout นี้ใช้กับบริษัทนี้เท่านั้น และใช้กับไฟล์ Export ด้วย'), list, err), [
    h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog('คืนค่ามาตรฐาน', 'ลบ Layout ของบริษัทนี้และกลับไปใช้ลำดับคอลัมน์มาตรฐาน?', 'คืนค่ามาตรฐาน', true))) return;
      try {
        await del(`/api/payroll/layouts/${companyId}`);
        dlg.close();
        toast('คืนค่า Layout มาตรฐานแล้ว');
        onDone();
      } catch (e) {
        err.textContent = msg(e);
      }
    } }, 'Reset'),
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'ยกเลิก'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await put(`/api/payroll/layouts/${companyId}`, { columns: cols });
        dlg.close();
        toast('บันทึก Layout แล้ว');
        onDone();
      } catch (e) {
        err.textContent = msg(e);
      }
    } }, 'บันทึก Layout'),
  ]);
}
