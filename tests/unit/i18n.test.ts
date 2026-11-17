// UI translation (Thai source → English / Chinese): dictionary coverage, placeholders, and the runtime matcher.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import catalog from '../../src/web/i18n/catalog.json';
import en from '../../src/web/i18n/en.json';
import zh from '../../src/web/i18n/zh.json';
import { compile, hasThai, placeholdersMatch } from '../../src/shared/i18n-core';

const DICTS = { en: en as Record<string, string>, zh: zh as Record<string, string> };

describe('UI dictionaries', () => {
  it('the catalog is up to date with the Thai strings in src/ (run node scripts/i18n-extract.mjs)', () => {
    expect(() => execFileSync(process.execPath, ['scripts/i18n-extract.mjs', '--check'], { encoding: 'utf8' })).not.toThrow();
  });

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang}: every catalog string has a translation without Thai text`, () => {
      const missing = Object.keys(catalog).filter((k) => !dict[k]);
      expect(missing).toEqual([]);
      const stillThai = Object.entries(dict).filter(([, v]) => hasThai(v)).map(([k]) => k);
      expect(stillThai).toEqual([]);
    });
    it(`${lang}: placeholders {0}, {1}… are kept`, () => {
      const bad = Object.entries(dict).filter(([k, v]) => !placeholdersMatch(k, v)).map(([k]) => k);
      expect(bad).toEqual([]);
    });
  }
});

describe('runtime matcher', () => {
  const t = compile({
    'บันทึก': 'Save',
    'ทั้งหมด {0} รายการ': '{0} items in total',
    'บริษัท: {0}': 'Company: {0}',
    'ทุกบริษัท': 'All companies',
    'ยืนยันโดย {0} เมื่อ {1}': 'Confirmed by {0} at {1}',
    'เลือกแล้ว {0} คน · แสดง {1} คน': '{0} selected · showing {1}',
    'ร่าง': 'Draft',
    'อนุมัติแล้ว': 'Approved',
  });
  it('translates exact strings and keeps surrounding white space', () => {
    expect(t('บันทึก')).toBe('Save');
    expect(t('  บันทึก ')).toBe('  Save ');
  });
  it('fills patterns, translating known parts and keeping data as it is', () => {
    expect(t('ทั้งหมด 12 รายการ')).toBe('12 items in total');
    expect(t('บริษัท: ทุกบริษัท')).toBe('Company: All companies');
    expect(t('บริษัท: สยาม จำกัด')).toBe('Company: สยาม จำกัด');
    expect(t('ยืนยันโดย สมชาย ใจดี เมื่อ 17 พ.ย. 2569')).toBe('Confirmed by สมชาย ใจดี at 17 พ.ย. 2569');
    expect(t('เลือกแล้ว 3 คน · แสดง 5 คน')).toBe('3 selected · showing 5');
  });
  it('joins known parts separated by " · ", by line breaks, or by spaces when every word is known', () => {
    expect(t('ร่าง · อนุมัติแล้ว')).toBe('Draft · Approved');
    expect(t('E001 1 Nov 2026\nร่าง')).toBe('E001 1 Nov 2026\nDraft');
    expect(t('ร่าง อนุมัติแล้ว')).toBe('Draft Approved');
    expect(t('ร่าง สมชาย')).toBe('ร่าง สมชาย'); // one unknown word: left as it is
  });
  it('a short label before data does not rewrite a Thai name; adjacent slots are filled as one', () => {
    const x = compile({ 'บริษัท {0}': 'Company {0}', 'ทุกบริษัท': 'All companies', 'สถานะ: {0}{1}': 'Status: {0}{1}', 'เปิด': 'On' });
    expect(x('บริษัท เดโม่ เอชอาร์ จำกัด')).toBe('บริษัท เดโม่ เอชอาร์ จำกัด');
    expect(x('บริษัท ทุกบริษัท')).toBe('Company All companies');
    expect(x('สถานะ: เปิด')).toBe('Status: On');
  });
  it('leaves unknown text (names, departments) unchanged', () => {
    expect(t('นายสมชาย ใจดี')).toBe('นายสมชาย ใจดี');
    expect(t('Finance Department')).toBe('Finance Department');
    expect(t.lookup('ฝ่ายบัญชีกลาง')).toBeNull();
  });
  it('real dictionaries translate menu and common UI text', () => {
    const e = compile(DICTS.en);
    const z = compile(DICTS.zh);
    expect(e('ออกจากระบบ')).toBe('Sign out');
    expect(z('ออกจากระบบ')).toBe('退出登录');
    expect(e('หน้า 2 / 9')).toBe('Page 2 / 9');
    expect(e('เข้าสู่ระบบ')).toBe('Sign in');
  });
});
