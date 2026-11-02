// Minimal DOM builder. All text goes through textContent / attributes, never innerHTML.

export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') (el as unknown as Record<string, unknown>)[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function mount(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(box);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

export function modal(title: string, body: Child, actions: Child = null): { close: () => void; root: HTMLElement } {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'ปิด', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions ? h('div', { class: 'modal-actions' }, actions) : null,
  );
  const backdrop = h('div', { class: 'backdrop', onclick: (e: Event) => e.target === backdrop && close() }, dialog);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  (dialog.querySelector('input,select,textarea,button.primary') as HTMLElement | null)?.focus();
  return { close, root: dialog };
}

export function confirmDialog(title: string, message: string, confirmLabel = 'ยืนยัน', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal(title, h('p', null, message), [
      h('button', { class: 'btn', onclick: () => finish(false) }, 'ยกเลิก'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmLabel),
    ]);
    const observer = new MutationObserver(() => {
      if (!m.root.isConnected) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

export function promptDialog(title: string, label: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('textarea', { rows: 3, maxlength: 500 });
    const m = modal(title, h('label', { class: 'field' }, h('span', null, label), input), [
      h('button', { class: 'btn', onclick: () => (m.close(), resolve(null)) }, 'ยกเลิก'),
      h('button', { class: 'btn primary', onclick: () => (m.close(), resolve(input.value.trim())) }, confirmLabel),
    ]);
  });
}

export function loading(): HTMLElement {
  return h('div', { class: 'loading', 'aria-busy': 'true' }, 'กำลังโหลด…');
}

export function errorBox(err: unknown): HTMLElement {
  const msg = err instanceof Error ? err.message : String(err);
  return h('div', { class: 'alert alert-error', role: 'alert' }, msg);
}

const money = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
export const fmtMoney = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : typeof v === 'number' ? money.format(v) : String(v));
export const fmtNum = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : typeof v === 'number' ? num.format(v) : String(v));
export function fmtDate(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return v === null || v === undefined ? '-' : String(v);
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) + (v.length > 10 ? ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '');
}
