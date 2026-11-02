import qrcode from 'qrcode-generator';
import type { AuthPolicy, LoginResponse, Me } from '../../shared/types';
import { get, post, ApiFailure } from '../api';
import { h, mount, toast, errorBox, fmtDate, loading, type Child } from '../dom';

// ---- Authentication layout (brand panel + form card) ----------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON = {
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  audit: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 14l2 2 4-4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
  alert: 'M12 8v4M12 16h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  check: 'M20 6 9 17l-5-5',
} as const;

function icon(d: string, cls = 'ico'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function authShell(opts: { icon: string; title: string; subtitle: string; body: Child }): HTMLElement {
  return h('div', { class: 'auth' },
    h('aside', { class: 'auth-brand' },
      h('div', { class: 'auth-logo' }, h('span', { class: 'auth-logo-mark' }, 'HR'), h('span', { class: 'auth-logo-text' }, 'HR SYSTEM')),
      h('div', { class: 'auth-hero' },
        h('p', { class: 'auth-eyebrow' }, 'PEOPLE · PERFORMANCE · PAYROLL'),
        h('h1', null, 'บริหารคนอย่างมืออาชีพ', h('br'), h('span', { class: 'auth-accent' }, 'ครบในระบบเดียว')),
        h('p', { class: 'auth-lead' }, 'HRM · HRD · HROD · Payroll สำหรับองค์กรที่ต้องการข้อมูลบุคลากรที่ถูกต้องและปลอดภัย'),
        h('ul', { class: 'auth-features' },
          h('li', null, icon(ICON.lock), 'เข้ารหัสและยืนยันตัวตน 2 ขั้นตอน'),
          h('li', null, icon(ICON.shield), 'สิทธิ์ตามบทบาท (RBAC)'),
          h('li', null, icon(ICON.audit), 'บันทึก Audit ทุกการทำรายการ'))),
      h('p', { class: 'auth-brand-foot' }, 'HR SYSTEM · HUMAN CAPITAL PLATFORM')),
    h('main', { class: 'auth-main' },
      h('div', { class: 'auth-card' },
        h('div', { class: 'auth-icon' }, icon(opts.icon)),
        h('h2', { class: 'auth-title' }, opts.title),
        h('p', { class: 'auth-subtitle' }, opts.subtitle),
        opts.body),
      h('footer', { class: 'auth-foot' }, `© ${new Date().getFullYear()} HR System · ข้อมูลทุกรายการได้รับการคุ้มครองตาม PDPA`)));
}

/** Password input with a show/hide toggle and caps-lock hint. */
function passwordInput(attrs: Record<string, unknown>): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { ...attrs, type: 'password' });
  const toggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'แสดงรหัสผ่าน', 'aria-pressed': 'false', title: 'แสดง/ซ่อนรหัสผ่าน' }, icon(ICON.eye));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
    toggle.replaceChildren(icon(show ? ICON.eyeOff : ICON.eye));
    input.focus();
  });
  const caps = h('small', { class: 'caps-hint', hidden: true }, 'Caps Lock เปิดอยู่');
  input.addEventListener('keyup', (e: KeyboardEvent) => {
    caps.hidden = !e.getModifierState?.('CapsLock');
  });
  return { wrap: h('div', { class: 'pw-field' }, h('div', { class: 'pw-wrap' }, input, toggle), caps), input };
}

function authField(label: string, control: HTMLElement, hint?: string, forId?: string): HTMLElement {
  return h('div', { class: 'auth-field' }, h('label', { for: forId }, label), control, hint ? h('small', { class: 'auth-hint' }, hint) : null);
}

function alertBox(): { el: HTMLElement; show: (msg: string, kind?: 'error' | 'info' | 'ok') => void; clear: () => void } {
  const el = h('div', { class: 'auth-alert', role: 'alert', hidden: true });
  return {
    el,
    show: (msg, kind = 'error') => {
      el.className = `auth-alert auth-alert-${kind}`;
      el.replaceChildren(icon(kind === 'ok' ? ICON.check : ICON.alert), h('span', null, msg));
      el.hidden = false;
    },
    clear: () => {
      el.hidden = true;
      el.className = 'auth-alert';
      el.replaceChildren();
    },
  };
}

function markInvalid(form: HTMLElement, field?: string): void {
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
  if (!field) return;
  const el = form.querySelector<HTMLInputElement>(`[name="${field}"]`);
  if (el) {
    el.setAttribute('aria-invalid', 'true');
    el.focus();
  }
}

function policyNotes(policy: AuthPolicy): HTMLElement {
  // Every statement here is derived from the live settings, so the page never promises behaviour the system does not have.
  return h('ul', { class: 'auth-notes' },
    h('li', null, `ใส่รหัสผ่านผิด ${policy.lockoutThreshold} ครั้ง บัญชีจะถูกล็อก ${policy.lockoutMinutes} นาที`),
    policy.mfaEnforcedForPrivileged
      ? h('li', null, 'บทบาทสิทธิ์สูง (Super Admin, HR Admin, Payroll Officer) ต้องยืนยันตัวตน 2 ขั้นตอน (MFA)')
      : h('li', null, 'MFA เป็นทางเลือก — เปิดใช้ได้ที่เมนู ความปลอดภัย & MFA'));
}

export function renderLogin(root: HTMLElement, policy: AuthPolicy, onDone: () => void, go: (path: string) => void): void {
  const username = h('input', { id: 'login-username', name: 'username', autocomplete: 'username', required: true, maxlength: 100, placeholder: 'ชื่อผู้ใช้หรือรหัสบัญชี', autocapitalize: 'none', spellcheck: 'false' });
  const pw = passwordInput({ id: 'login-password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'รหัสผ่าน' });
  const totp = h('input', { id: 'login-totp', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6, placeholder: '000000', class: 'otp' });
  const totpField = h('div', { hidden: true }, authField('รหัสยืนยัน 6 หลักจากแอป Authenticator', totp, 'เปิดแอป Authenticator แล้วกรอกรหัสที่แสดงอยู่', 'login-totp'));
  const alert = alertBox();
  const submit = h('button', { class: 'auth-submit', type: 'submit' }, 'เข้าสู่ระบบ');
  const form = h('form', {
    class: 'auth-form',
    novalidate: true,
    onsubmit: async (e: Event) => {
      e.preventDefault();
      alert.clear();
      markInvalid(form);
      const fail = (msg: string, field: string) => {
        alert.show(msg);
        markInvalid(form, field);
      };
      if (!username.value.trim()) return fail('กรุณากรอกชื่อผู้ใช้', 'username');
      if (!pw.input.value) return fail('กรุณากรอกรหัสผ่าน', 'password');
      if (!totpField.hidden && !/^\d{6}$/.test(totp.value)) return fail('รหัสยืนยันต้องเป็นตัวเลข 6 หลัก', 'totp');
      submit.disabled = true;
      submit.textContent = 'กำลังตรวจสอบ…';
      try {
        const res = await post<LoginResponse>('/api/auth/login', { username: username.value.trim(), password: pw.input.value, totp: totpField.hidden ? undefined : totp.value });
        if (res.status === 'mfa_required') {
          totpField.hidden = false;
          alert.show('บัญชีนี้เปิดใช้ MFA กรุณากรอกรหัสยืนยัน 6 หลัก', 'info');
          totp.focus();
          return;
        }
        history.replaceState(null, '', '/');
        onDone();
      } catch (err) {
        alert.show(err instanceof ApiFailure ? err.message : 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่');
        if (err instanceof ApiFailure && err.status === 401 && !totpField.hidden && /MFA/.test(err.message)) markInvalid(form, 'totp');
        else if (err instanceof ApiFailure && err.status === 401) {
          pw.input.value = '';
          markInvalid(form, 'password');
        }
      } finally {
        submit.disabled = false;
        submit.textContent = 'เข้าสู่ระบบ';
      }
    },
  },
  alert.el,
  authField('ชื่อผู้ใช้ / บัญชี', username, undefined, 'login-username'),
  authField('รหัสผ่าน', pw.wrap, undefined, 'login-password'),
  totpField, submit,
  h('p', { class: 'auth-switch' }, policy.selfRegistration
    ? ['ยังไม่มีบัญชี? ', h('a', { href: '/register', onclick: (e: Event) => { e.preventDefault(); go('/register'); } }, 'ลงทะเบียน')]
    : 'ยังไม่มีบัญชี? ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์ใช้งาน'),
  policyNotes(policy));
  document.title = 'เข้าสู่ระบบ · HR System';
  form.addEventListener('input', () => alert.clear()); // stale errors disappear while the user corrects them
  mount(root, authShell({ icon: ICON.users, title: 'ยินดีต้อนรับกลับ', subtitle: 'เข้าสู่ระบบเพื่อใช้งาน HR System', body: form }));
  username.focus();
}

export function renderRegister(root: HTMLElement, policy: AuthPolicy, go: (path: string) => void): void {
  document.title = 'ลงทะเบียน · HR System';
  const toLogin = (e?: Event) => {
    e?.preventDefault();
    go('/login');
  };
  if (!policy.selfRegistration) {
    mount(root, authShell({
      icon: ICON.userPlus, title: 'ปิดการลงทะเบียน', subtitle: 'ผู้ดูแลระบบปิดการลงทะเบียนด้วยตนเอง กรุณาติดต่อฝ่าย HR เพื่อขอบัญชีผู้ใช้',
      body: h('a', { class: 'auth-submit as-link', href: '/login', onclick: toLogin }, 'กลับไปหน้าเข้าสู่ระบบ'),
    }));
    return;
  }
  const displayName = h('input', { id: 'reg-name', name: 'displayName', autocomplete: 'name', maxlength: 100, required: true, placeholder: 'ชื่อ-นามสกุล' });
  const username = h('input', { id: 'reg-username', name: 'username', autocomplete: 'username', maxlength: 50, required: true, placeholder: 'เช่น somchai.k', autocapitalize: 'none', spellcheck: 'false' });
  const email = h('input', { id: 'reg-email', name: 'email', type: 'email', autocomplete: 'email', maxlength: 200, placeholder: 'name@company.com' });
  const empCode = h('input', { id: 'reg-emp', name: 'employeeCode', maxlength: 20, placeholder: 'เช่น E0123 (ถ้ามี)' });
  const pw = passwordInput({ id: 'reg-password', name: 'password', autocomplete: 'new-password', required: true, placeholder: `อย่างน้อย ${policy.passwordMinLength} ตัวอักษร` });
  const confirm = passwordInput({ id: 'reg-confirm', name: 'confirmPassword', autocomplete: 'new-password', required: true, placeholder: 'พิมพ์รหัสผ่านอีกครั้ง' });

  const rules = [
    { test: (p: string) => p.length >= policy.passwordMinLength, label: `อย่างน้อย ${policy.passwordMinLength} ตัวอักษร` },
    { test: (p: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3, label: 'มี 3 ใน 4 ประเภท: a-z, A-Z, 0-9, สัญลักษณ์' },
    { test: (p: string) => !username.value.trim() || !p.toLowerCase().includes(username.value.trim().toLowerCase()), label: 'ไม่มีชื่อผู้ใช้อยู่ในรหัสผ่าน' },
  ];
  const ruleItems = rules.map((r) => ({ r, el: h('li', null, icon(ICON.check), r.label) }));
  const matchHint = h('small', { class: 'auth-hint' });
  const refresh = () => {
    for (const { r, el } of ruleItems) el.classList.toggle('ok', r.test(pw.input.value));
    const filled = !!confirm.input.value;
    const same = confirm.input.value === pw.input.value;
    matchHint.textContent = filled ? (same ? '✓ รหัสผ่านตรงกัน' : 'รหัสผ่านไม่ตรงกัน') : '';
    matchHint.className = `auth-hint ${filled ? (same ? 'ok' : 'bad') : ''}`;
  };
  for (const el of [pw.input, confirm.input, username]) el.addEventListener('input', refresh);

  const alert = alertBox();
  const submit = h('button', { class: 'auth-submit', type: 'submit' }, 'ส่งคำขอลงทะเบียน');
  const form = h('form', {
    class: 'auth-form',
    novalidate: true,
    onsubmit: async (e: Event) => {
      e.preventDefault();
      alert.clear();
      markInvalid(form);
      const fail = (msg: string, field: string) => {
        alert.show(msg);
        markInvalid(form, field);
      };
      if (!displayName.value.trim()) return fail('กรุณากรอกชื่อ-นามสกุล', 'displayName');
      if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username.value.trim())) return fail('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z A-Z 0-9 . _ - ความยาว 3-50 ตัว', 'username');
      if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return fail('รูปแบบอีเมลไม่ถูกต้อง', 'email');
      const broken = rules.find((r) => !r.test(pw.input.value));
      if (broken) return fail(`รหัสผ่านยังไม่ผ่านเงื่อนไข: ${broken.label}`, 'password');
      if (pw.input.value !== confirm.input.value) return fail('ยืนยันรหัสผ่านไม่ตรงกัน', 'confirmPassword');
      submit.disabled = true;
      submit.textContent = 'กำลังส่งคำขอ…';
      try {
        await post('/api/auth/register', {
          displayName: displayName.value.trim(), username: username.value.trim(), email: email.value.trim() || null,
          employeeCode: empCode.value.trim() || null, password: pw.input.value, confirmPassword: confirm.input.value,
        });
        mount(root, authShell({
          icon: ICON.check, title: 'ส่งคำขอลงทะเบียนแล้ว',
          subtitle: `บัญชี ${username.value.trim()} อยู่ระหว่างรอผู้ดูแลระบบ (Super Admin) อนุมัติและกำหนดบทบาท คุณจะเข้าสู่ระบบได้เมื่อได้รับการอนุมัติ`,
          body: h('a', { class: 'auth-submit as-link', href: '/login', onclick: toLogin }, 'กลับไปหน้าเข้าสู่ระบบ'),
        }));
      } catch (err) {
        const field = err instanceof ApiFailure ? (err.details as { field?: string } | undefined)?.field : undefined;
        alert.show(err instanceof ApiFailure ? err.message : 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่');
        markInvalid(form, field ?? (err instanceof ApiFailure && err.status === 409 ? 'username' : undefined));
      } finally {
        if (submit.isConnected) {
          submit.disabled = false;
          submit.textContent = 'ส่งคำขอลงทะเบียน';
        }
      }
    },
  },
  alert.el,
  h('div', { class: 'auth-grid' },
    authField('ชื่อ-นามสกุล *', displayName, undefined, 'reg-name'),
    authField('ชื่อผู้ใช้ *', username, 'a-z, 0-9 และ . _ -', 'reg-username'),
    authField('อีเมล', email, undefined, 'reg-email'),
    authField('รหัสพนักงาน', empCode, 'ช่วยให้ผู้ดูแลผูกบัญชีกับข้อมูลพนักงาน', 'reg-emp')),
  authField('รหัสผ่าน *', pw.wrap, undefined, 'reg-password'),
  h('ul', { class: 'pw-rules', 'aria-live': 'polite' }, ruleItems.map((x) => x.el)),
  h('div', { class: 'auth-field' }, h('label', { for: 'reg-confirm' }, 'ยืนยันรหัสผ่าน *'), confirm.wrap, matchHint),
  h('div', { class: 'auth-notice' }, icon(ICON.shield), h('span', null, 'บัญชีใหม่จะยังไม่มีสิทธิ์ใช้งานจนกว่า Super Admin จะตรวจสอบ อนุมัติ และกำหนดบทบาทให้')),
  submit,
  h('p', { class: 'auth-switch' }, 'มีบัญชีอยู่แล้ว? ', h('a', { href: '/login', onclick: toLogin }, 'เข้าสู่ระบบ')));
  form.addEventListener('input', () => alert.clear());
  mount(root, authShell({ icon: ICON.userPlus, title: 'ลงทะเบียนผู้ใช้ใหม่', subtitle: 'กรอกข้อมูลเพื่อขอบัญชีใช้งาน HR System', body: form }));
  displayName.focus();
}


/** MFA enrolment widget (used by the forced flow and the Security page). */
export function mfaSetup(onEnabled: () => void): HTMLElement {
  const box = h('div', { class: 'mfa-setup' }, h('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        const r = await post<{ secret: string; otpauthUrl: string }>('/api/security/mfa/setup');
        const qr = qrcode(0, 'M');
        qr.addData(r.otpauthUrl);
        qr.make();
        const code = h('input', { inputmode: 'numeric', maxlength: 6, pattern: '\\d{6}', autocomplete: 'one-time-code' });
        const msg = h('div', { class: 'form-msg', role: 'alert' });
        mount(box,
          h('ol', null, h('li', null, 'สแกน QR ด้วยแอป Authenticator (Google/Microsoft Authenticator ฯลฯ) หรือพิมพ์รหัสลับด้านล่าง'), h('li', null, 'กรอกรหัส 6 หลักที่แอปแสดงเพื่อยืนยัน')),
          h('img', { src: qr.createDataURL(5, 8), alt: 'QR code สำหรับตั้งค่า MFA', class: 'qr' }),
          h('p', null, 'รหัสลับ: ', h('code', { class: 'secret' }, r.secret.replace(/(.{4})/g, '$1 ').trim())),
          h('form', {
            class: 'inline-form',
            onsubmit: async (e: Event) => {
              e.preventDefault();
              try {
                await post('/api/security/mfa/enable', { code: code.value });
                toast('เปิดใช้ MFA เรียบร้อย');
                onEnabled();
              } catch (err) {
                msg.textContent = err instanceof Error ? err.message : String(err);
              }
            },
          }, h('label', { class: 'field' }, h('span', null, 'รหัส 6 หลัก'), code), h('button', { class: 'btn primary', type: 'submit' }, 'ยืนยันและเปิดใช้')),
          msg,
        );
        code.focus();
      } catch (err) {
        mount(box, errorBox(err));
      }
    },
  }, 'เริ่มตั้งค่า MFA'));
  return box;
}

export function changePasswordForm(policy: AuthPolicy, onDone: () => void): HTMLElement {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: policy.passwordMinLength });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  return h('form', {
    class: 'stack',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      if (next.value !== confirm.value) {
        msg.textContent = 'รหัสผ่านใหม่ไม่ตรงกัน';
        return;
      }
      try {
        await post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
        toast('เปลี่ยนรหัสผ่านเรียบร้อย');
        onDone();
      } catch (err) {
        msg.textContent = err instanceof Error ? err.message : String(err);
      }
    },
  },
  h('label', { class: 'field' }, h('span', null, 'รหัสผ่านปัจจุบัน'), current),
  h('label', { class: 'field' }, h('span', null, `รหัสผ่านใหม่ (อย่างน้อย ${policy.passwordMinLength} ตัว และมี 3 ใน 4 ประเภท: a-z, A-Z, 0-9, สัญลักษณ์)`), next),
  h('label', { class: 'field' }, h('span', null, 'ยืนยันรหัสผ่านใหม่'), confirm),
  msg, h('button', { class: 'btn primary', type: 'submit' }, 'เปลี่ยนรหัสผ่าน'));
}

async function signOut(onDone: () => void): Promise<void> {
  await post('/api/auth/logout');
  onDone();
}

export function renderForcedMfa(root: HTMLElement, me: Me, onDone: () => void): void {
  document.title = 'ตั้งค่า MFA · HR System';
  mount(root, authShell({
    icon: ICON.shield, title: 'ตั้งค่า MFA ก่อนใช้งาน',
    subtitle: `บัญชี ${me.username} มีบทบาทสิทธิ์สูง และนโยบายของระบบบังคับใช้การยืนยันตัวตน 2 ขั้นตอน`,
    body: [mfaSetup(onDone), h('button', { class: 'auth-link-btn', type: 'button', onclick: () => void signOut(onDone) }, 'ออกจากระบบ')],
  }));
}

export function renderForcedPassword(root: HTMLElement, policy: AuthPolicy, onDone: () => void): void {
  document.title = 'เปลี่ยนรหัสผ่าน · HR System';
  mount(root, authShell({
    icon: ICON.key, title: 'ตั้งรหัสผ่านใหม่',
    subtitle: 'บัญชีนี้ใช้รหัสผ่านชั่วคราว ต้องเปลี่ยนก่อนเริ่มใช้งาน',
    body: [changePasswordForm(policy, onDone), h('button', { class: 'auth-link-btn', type: 'button', onclick: () => void signOut(onDone) }, 'ออกจากระบบ')],
  }));
}

interface SecurityStatus {
  mfaEnabled: boolean;
  mfaRequired: boolean;
  mfaAvailable: boolean;
  policy: AuthPolicy;
  sessions: Array<{ ip: string | null; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean }>;
}

export async function renderSecurity(main: HTMLElement): Promise<void> {
  mount(main, loading());
  const s = await get<SecurityStatus>('/api/security/status');
  const reload = () => void renderSecurity(main);
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  mount(main,
    h('section', { class: 'card' }, h('h2', null, 'การยืนยันตัวตน 2 ขั้นตอน (MFA)'),
      h('p', null, 'สถานะ: ', h('strong', null, s.mfaEnabled ? 'เปิดใช้งาน' : 'ยังไม่เปิดใช้งาน'), s.mfaRequired ? ' · นโยบายบังคับใช้สำหรับบทบาทของคุณ' : ''),
      !s.mfaAvailable ? h('div', { class: 'alert' }, 'ผู้ดูแลระบบยังไม่ได้ตั้งค่ากุญแจเข้ารหัส MFA จึงยังเปิดใช้ไม่ได้') : null,
      !s.mfaEnabled && s.mfaAvailable ? mfaSetup(reload) : null,
      s.mfaEnabled && !s.mfaRequired
        ? h('form', { class: 'inline-form', onsubmit: async (e: Event) => { e.preventDefault(); try { await post('/api/security/mfa/disable', { password: password.value }); toast('ปิด MFA แล้ว'); reload(); } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); } } },
            h('label', { class: 'field' }, h('span', null, 'ยืนยันด้วยรหัสผ่าน'), password), h('button', { class: 'btn danger', type: 'submit' }, 'ปิด MFA'))
        : null,
    ),
    h('section', { class: 'card' }, h('h2', null, 'เปลี่ยนรหัสผ่าน'), changePasswordForm(s.policy, reload)),
    h('section', { class: 'card' }, h('h2', null, 'Session ที่ใช้งานอยู่'),
      h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'เริ่ม'), h('th', null, 'หมดอายุ'), h('th', null, 'IP'), h('th', null, 'อุปกรณ์'))),
        h('tbody', null, s.sessions.map((x) => h('tr', null, h('td', null, fmtDate(x.createdAt), x.current ? ' (ปัจจุบัน)' : ''), h('td', null, fmtDate(x.expiresAt)), h('td', null, x.ip ?? '-'), h('td', { class: 'truncate' }, x.userAgent ?? '-')))))),
  );
}
