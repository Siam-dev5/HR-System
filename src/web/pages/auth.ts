import qrcode from 'qrcode-generator';
import type { AuthPolicy, LoginResponse, Me } from '../../shared/types';
import { get, post, ApiFailure } from '../api';
import { h, mount, toast, errorBox, fmtDate, loading } from '../dom';

function policyNotes(policy: AuthPolicy): HTMLElement {
  // Every statement here is derived from the live settings, so the page never promises behaviour the system does not have.
  return h('ul', { class: 'policy-notes' },
    h('li', null, `ใส่รหัสผ่านผิด ${policy.lockoutThreshold} ครั้ง บัญชีจะถูกล็อก ${policy.lockoutMinutes} นาที`),
    policy.mfaEnforcedForPrivileged
      ? h('li', null, 'บทบาทสิทธิ์สูง (Super Admin, HR Admin, Payroll Officer) ต้องยืนยันตัวตน 2 ขั้นตอน (MFA)')
      : h('li', null, 'MFA เป็นทางเลือก — เปิดใช้ได้ที่เมนู ความปลอดภัย & MFA'),
    h('li', null, 'ทุกการเข้าสู่ระบบถูกบันทึกใน Audit Log'),
  );
}

export function renderLogin(root: HTMLElement, policy: AuthPolicy, onDone: () => void): void {
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 100 });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const totp = h('input', { name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6 });
  const totpField = h('label', { class: 'field', hidden: true }, h('span', null, 'รหัส MFA 6 หลักจากแอป Authenticator'), totp);
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'เข้าสู่ระบบ');
  const form = h('form', {
    class: 'login-form',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.textContent = '';
      submit.disabled = true;
      try {
        const res = await post<LoginResponse>('/api/auth/login', { username: username.value, password: password.value, totp: totpField.hidden ? undefined : totp.value });
        if (res.status === 'mfa_required') {
          totpField.hidden = false;
          totp.focus();
          msg.textContent = 'กรุณากรอกรหัส MFA';
          return;
        }
        history.replaceState(null, '', '/');
        onDone();
      } catch (err) {
        msg.textContent = err instanceof ApiFailure ? err.message : 'เข้าสู่ระบบไม่สำเร็จ';
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('label', { class: 'field' }, h('span', null, 'ชื่อผู้ใช้'), username),
  h('label', { class: 'field' }, h('span', null, 'รหัสผ่าน'), password),
  totpField, msg, submit);
  document.title = 'เข้าสู่ระบบ · HR System';
  mount(root, h('div', { class: 'login-page' }, h('div', { class: 'login-card' }, h('div', { class: 'brand big' }, h('span', { class: 'brand-mark' }, 'HR'), h('span', null, 'HR System')), h('p', { class: 'muted' }, 'HRM · HRD · HROD · Payroll'), form, policyNotes(policy))));
  username.focus();
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
  mount(root, h('div', { class: 'login-page' }, h('div', { class: 'login-card wide' },
    h('h2', null, 'ต้องตั้งค่า MFA ก่อนใช้งาน'),
    h('p', null, `บัญชี ${me.username} มีบทบาทสิทธิ์สูง และนโยบายของระบบบังคับใช้การยืนยันตัวตน 2 ขั้นตอน`),
    mfaSetup(onDone),
    h('button', { class: 'btn link', onclick: () => void signOut(onDone) }, 'ออกจากระบบ'),
  )));
}

export function renderForcedPassword(root: HTMLElement, policy: AuthPolicy, onDone: () => void): void {
  document.title = 'เปลี่ยนรหัสผ่าน · HR System';
  mount(root, h('div', { class: 'login-page' }, h('div', { class: 'login-card wide' },
    h('h2', null, 'กรุณาตั้งรหัสผ่านใหม่'),
    h('p', null, 'บัญชีนี้ใช้รหัสผ่านชั่วคราว ต้องเปลี่ยนก่อนเริ่มใช้งาน'),
    changePasswordForm(policy, onDone),
    h('button', { class: 'btn link', onclick: () => void signOut(onDone) }, 'ออกจากระบบ'),
  )));
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
