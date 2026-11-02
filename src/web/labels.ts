// Display labels for stored option codes.
const LABELS: Record<string, string> = {
  active: 'ใช้งาน/ปฏิบัติงาน', probation: 'ทดลองงาน', resigned: 'ลาออก', terminated: 'เลิกจ้าง',
  permanent: 'ประจำ', contract: 'สัญญาจ้าง', intern: 'ฝึกงาน',
  pending: 'รออนุมัติ', approved: 'อนุมัติ', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก',
  open: 'เปิด', in_progress: 'กำลังดำเนินการ', done: 'เสร็จสิ้น', closed: 'ปิด', on_hold: 'พักไว้', filled: 'ได้คนแล้ว',
  resign: 'ลาออก', retire: 'เกษียณ', terminate: 'เลิกจ้าง', contract_end: 'ครบสัญญา', cleared: 'เคลียร์แล้ว',
  present: 'มาทำงาน', late: 'มาสาย', absent: 'ขาดงาน', leave: 'ลา', web: 'เว็บ', device: 'เครื่องสแกน', manual: 'บันทึกเอง',
  website: 'เว็บไซต์', referral: 'แนะนำ', jobboard: 'Job board', agency: 'บริษัทจัดหา', other: 'อื่น ๆ',
  applied: 'สมัครแล้ว', screening: 'คัดกรอง', interview: 'สัมภาษณ์', offer: 'เสนองาน', hired: 'รับเข้าทำงาน',
  planning: 'วางแผน', draft: 'ร่าง', submitted: 'ส่งแล้ว', calibrated: 'Calibrate แล้ว',
  core: 'Core', managerial: 'Managerial', functional: 'Functional', high: 'สูง', medium: 'กลาง', low: 'ต่ำ',
  identified: 'ระบุแล้ว', planned: 'วางแผนแล้ว', classroom: 'ห้องเรียน', online: 'ออนไลน์', blended: 'ผสม',
  enrolled: 'ลงทะเบียน', attended: 'เข้าร่วม', completed: 'สำเร็จ', no_show: 'ไม่มา', review: 'ทบทวน',
  engagement: 'Engagement', enps: 'eNPS', pulse: 'Pulse', earning: 'เงินได้', deduction: 'เงินหัก',
  policy: 'นโยบาย', form: 'แบบฟอร์ม', certificate: 'หนังสือรับรอง', access: 'ขอเข้าถึง', rectify: 'ขอแก้ไข', erase: 'ขอลบ', object: 'คัดค้าน', portability: 'ขอโอนย้าย',
  received: 'รับเรื่อง', overtime: 'OT', time_correction: 'แก้ไขเวลา', calculated: 'คำนวณแล้ว', published: 'เผยแพร่แล้ว',
};

export const optionLabel = (code: string | number | null | undefined): string => (code === null || code === undefined ? '-' : (LABELS[String(code)] ?? String(code)));
