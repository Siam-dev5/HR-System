// Employee photo in the browser: initials fallback, the photo panel of the employee form (pick → preview → upload with
// progress, replace, remove) and the image URL used by the organization chart. Photos are only ever read through the
// authenticated API (same origin); nothing is cached by the browser (the API answers private, no-store).
import { AVATAR_MAX_BYTES, initialsOf, type AvatarMeta } from '../shared/avatar';
import { get, del } from './api';
import { basePath } from './app';
import { h, mount, confirmDialog, toast } from './dom';

/** Original files larger than this are refused before resizing (the stored photo is always far below 5 MB). */
const PICK_MAX_BYTES = 15 * 1024 * 1024;
const OUT_PX = 512;
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

export const avatarUrl = (employeeId: number, version: string) => `${basePath()}/api/employees/${employeeId}/avatar?v=${encodeURIComponent(version)}`;

/** Round photo with initials underneath; a missing or failed photo simply leaves the initials. */
export function avatarBadge(name: string, employeeId: number | null, version: string | null, size: 'sm' | 'lg' = 'lg'): HTMLElement {
  const box = h('span', { class: `emp-avatar emp-avatar-${size}`, 'data-avatar': version ? 'photo' : 'initials' }, h('span', { class: 'emp-avatar-initials', 'aria-hidden': 'true' }, initialsOf(name)));
  if (employeeId !== null && version) {
    const img = h('img', { class: 'emp-avatar-img', alt: `รูปของ ${name}`, src: avatarUrl(employeeId, version), decoding: 'async' });
    img.addEventListener('error', () => {
      img.remove();
      box.dataset.avatar = 'initials';
    });
    box.appendChild(img);
  }
  return box;
}

/** Decodes the picked image, scales it to at most 512 px and re-encodes it (WebP, or JPEG where WebP encoding is not
 *  available). Re-encoding also drops embedded metadata such as the GPS position of phone photos. */
async function prepare(file: File): Promise<Blob> {
  if (!ACCEPT.includes(file.type)) throw new Error('รองรับเฉพาะไฟล์ JPEG, PNG และ WebP');
  if (file.size > PICK_MAX_BYTES) throw new Error('ไฟล์ใหญ่เกิน 15 MB');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('อ่านไฟล์รูปไม่ได้ ไฟล์อาจเสียหาย');
  }
  const k = Math.min(1, OUT_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('เบราว์เซอร์นี้ย่อรูปไม่ได้');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  const webp = await encode('image/webp', 0.88);
  const out = webp?.type === 'image/webp' ? webp : await encode('image/jpeg', 0.9);
  if (!out || out.size > AVATAR_MAX_BYTES) throw new Error('ย่อรูปไม่สำเร็จ กรุณาใช้รูปอื่น');
  return out;
}

const dataUrl = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(new Error('แสดงตัวอย่างรูปไม่ได้'));
  r.readAsDataURL(blob);
});

/** PUT with upload progress (fetch has none); same CSRF header as every other change request. */
function upload(employeeId: number, blob: Blob, onProgress: (ratio: number) => void): Promise<AvatarMeta> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `${basePath()}/api/employees/${employeeId}/avatar`);
    x.setRequestHeader('x-hr-requested', '1');
    x.setRequestHeader('content-type', blob.type);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    x.onload = () => {
      let body: { avatar?: AvatarMeta; error?: { message?: string } } = {};
      try {
        body = JSON.parse(x.responseText || '{}');
      } catch {
        /* not JSON */
      }
      if (x.status === 200 && body.avatar) resolve(body.avatar);
      else reject(new Error(body.error?.message ?? `อัปโหลดไม่สำเร็จ (${x.status})`));
    };
    x.onerror = () => reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่'));
    x.send(blob);
  });
}

/** Photo section of the employee form. Management controls appear only when the API says this user may change it. */
export function avatarPanel(employee: { id: number; name: string }, onChange?: () => void): HTMLElement {
  const frame = h('div', { class: 'avatar-frame' });
  const status = h('p', { class: 'muted small avatar-status' }, 'กำลังโหลดรูป…');
  const bar = h('progress', { max: 100, value: 0, 'aria-label': 'ความคืบหน้าการอัปโหลด' });
  const pct = h('span', { class: 'small' }, '0%');
  const progress = h('div', { class: 'avatar-progress', hidden: true }, bar, pct);
  const msg = h('div', { class: 'form-msg', role: 'alert' });
  const actions = h('div', { class: 'toolbar avatar-actions' });
  const panel = h('div', { class: 'avatar-panel span2', 'data-employee': employee.id }, frame,
    h('div', { class: 'avatar-panel-body' }, h('strong', null, 'รูปพนักงาน'), status, progress, actions, msg));
  let current: AvatarMeta | null = null;
  let canManage = false;
  let pending: Blob | null = null;

  const show = (src: { kind: 'saved' } | { kind: 'preview'; url: string }) => {
    if (src.kind === 'preview') {
      mount(frame, h('span', { class: 'emp-avatar emp-avatar-lg', 'data-avatar': 'preview' }, h('img', { class: 'emp-avatar-img', alt: 'ตัวอย่างรูปใหม่', src: src.url })));
    } else mount(frame, avatarBadge(employee.name, employee.id, current?.version ?? null));
  };
  const btn = (label: string, run: () => void, cls = 'btn small') => h('button', { type: 'button', class: cls, onclick: run }, label);
  const render = () => {
    status.textContent = pending ? 'ตัวอย่างรูปใหม่ (ยังไม่บันทึก)' : current ? `มีรูปแล้ว · ${(current.size_bytes / 1024).toFixed(0)} KB` : 'ยังไม่มีรูป · แสดงอักษรย่อแทน';
    if (!canManage) return mount(actions);
    mount(actions,
      pending ? [btn('บันทึกรูป', () => void save(), 'btn small avatar-save'), btn('ยกเลิก', cancel)] : btn(current ? 'เปลี่ยนรูป…' : 'เลือกรูป…', pick),
      current && !pending ? btn('ลบรูป', () => void remove(), 'btn small danger') : null);
  };
  const pick = () => {
    // created on demand so the dialog's first focusable field stays the first form field
    const input = h('input', { type: 'file', accept: ACCEPT.join(','), hidden: true });
    input.addEventListener('change', async () => {
      msg.textContent = '';
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        pending = await prepare(file);
        show({ kind: 'preview', url: await dataUrl(pending) });
      } catch (e) {
        pending = null;
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
      render();
    });
    panel.appendChild(input);
    input.click();
  };
  const cancel = () => {
    pending = null;
    msg.textContent = '';
    show({ kind: 'saved' });
    render();
  };
  const save = async () => {
    if (!pending) return;
    msg.textContent = '';
    progress.hidden = false;
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      current = await upload(employee.id, pending, (r) => {
        bar.value = Math.round(r * 100);
        pct.textContent = `${Math.round(r * 100)}%`;
      });
      pending = null;
      show({ kind: 'saved' });
      toast('บันทึกรูปพนักงานแล้ว');
      onChange?.();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      progress.hidden = true;
      bar.value = 0;
      pct.textContent = '0%';
      render();
    }
  };
  const remove = async () => {
    if (!(await confirmDialog('ลบรูปพนักงาน', `ต้องการลบรูปของ ${employee.name} หรือไม่? ระบบจะแสดงอักษรย่อแทน`, 'ลบรูป', true))) return;
    msg.textContent = '';
    try {
      await del(`/api/employees/${employee.id}/avatar`);
      current = null;
      show({ kind: 'saved' });
      toast('ลบรูปแล้ว');
      onChange?.();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
    render();
  };

  show({ kind: 'saved' });
  void get<{ avatar: AvatarMeta | null; canManage: boolean }>(`/api/employees/${employee.id}/avatar/meta`).then((r) => {
    current = r.avatar;
    canManage = r.canManage;
    show({ kind: 'saved' });
    render();
  }, (e) => {
    status.textContent = 'โหลดข้อมูลรูปไม่ได้';
    msg.textContent = e instanceof Error ? e.message : String(e);
  });
  return panel;
}
