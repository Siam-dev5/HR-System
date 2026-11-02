import { describe, expect, it } from 'vitest';
import { hasPermission, permissionMatches } from '../../src/shared/permissions';
import { resolveLink } from '../../src/shared/links';
import { annualTax, calculatePay, monthlyWithholding, socialSecurity, DEFAULT_PAYROLL_CONFIG } from '../../src/shared/payroll';
import { decryptString, encryptString, generatePassword, hashPassword, toBase64, randomBytes, verifyPassword } from '../../src/shared/crypto';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../../src/shared/totp';

describe('permissions', () => {
  it('matches exact, resource wildcard, action wildcard and global wildcard', () => {
    expect(permissionMatches('employees.view', 'employees.view')).toBe(true);
    expect(permissionMatches('payroll.*', 'payroll.approve')).toBe(true);
    expect(permissionMatches('*.view', 'talent.view')).toBe(true);
    expect(permissionMatches('*', 'anything.at_all')).toBe(true);
    expect(permissionMatches('employees.view', 'employees.update')).toBe(false);
    expect(permissionMatches('*.view', 'users.manage')).toBe(false);
    expect(permissionMatches('payroll', 'payroll.view')).toBe(false);
  });
  it('hasPermission checks any pattern', () => {
    expect(hasPermission(['leave.view', 'leave.create'], 'leave.create')).toBe(true);
    expect(hasPermission([], 'leave.view')).toBe(false);
  });
});

describe('resolveLink (notification / widget links)', () => {
  it('keeps absolute URLs unchanged and never prefixes the base path (reference-system bug)', () => {
    expect(resolveLink('https://example.co.th/notifications/1', '/hr3in1')).toEqual({ href: 'https://example.co.th/notifications/1', external: true });
  });
  it('prefixes app paths with the base path exactly once', () => {
    expect(resolveLink('/leave', '/hr3in1')).toEqual({ href: '/hr3in1/leave', external: false });
    expect(resolveLink('/hr3in1/leave', '/hr3in1/')).toEqual({ href: '/hr3in1/leave', external: false });
    expect(resolveLink('/leave', '')).toEqual({ href: '/leave', external: false });
  });
  it('rejects unsafe or ambiguous links', () => {
    for (const bad of ['javascript:alert(1)', '//evil.example/x', 'data:text/html,hi', 'leave', '', null, undefined, 'http://']) {
      expect(resolveLink(bad as string)).toBeNull();
    }
  });
});

describe('payroll calculation', () => {
  it('social security is 5% clamped to the wage floor and ceiling', () => {
    expect(socialSecurity(30000)).toBe(750);
    expect(socialSecurity(10000)).toBe(500);
    expect(socialSecurity(1000)).toBe(82.5);
    expect(socialSecurity(0)).toBe(0);
    expect(socialSecurity(20000, { ...DEFAULT_PAYROLL_CONFIG, ssoMaxWage: 17500 })).toBe(875);
  });
  it('progressive annual tax', () => {
    expect(annualTax(150000)).toBe(0);
    expect(annualTax(300000)).toBe(7500);
    expect(annualTax(500000)).toBe(27500);
    expect(annualTax(1000000)).toBe(115000);
  });
  it('monthly withholding on 50,000/month', () => {
    // 600,000 - 100,000 expense - 60,000 personal - 9,000 SSO = 431,000 → 7,500 + 13,100 = 20,600 / 12
    expect(monthlyWithholding(50000, 750)).toBe(1716.67);
  });
  it('no tax for low income', () => {
    expect(monthlyWithholding(15000, 750)).toBe(0);
  });
  it('full payslip with OT, allowance, deduction and unpaid leave', () => {
    const r = calculatePay({
      baseSalary: 16500,
      overtime: [{ hours: 3, rate: 1.5 }],
      earnings: [{ code: 'MEAL', name: 'ค่าอาหาร', amount: 1000, taxable: true }],
      deductions: [{ code: 'LOAN', name: 'เงินกู้', amount: 500 }],
      unpaidLeaveDays: 1,
    });
    expect(r.otAmount).toBe(309.38); // 16500/30/8 = 68.75 × 1.5 × 3
    expect(r.unpaidLeave).toBe(550);
    expect(r.gross).toBe(17259.38); // 16500 - 550 + 309.38 + 1000
    expect(r.sso).toBe(750);
    expect(r.tax).toBe(0);
    expect(r.deductions).toBe(1250);
    expect(r.net).toBe(16009.38);
    expect(r.lines.map((l) => l.code)).toEqual(['BASE', 'OT', 'MEAL', 'UNPAID', 'SSO', 'TAX', 'LOAN']);
  });
  it('unpaid leave never exceeds the salary', () => {
    expect(calculatePay({ baseSalary: 9000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 40 }).unpaidLeave).toBe(9000);
  });
});

describe('crypto', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('Correct-Horse-9', 1000);
    expect(h.startsWith('pbkdf2$1000$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('encrypts and decrypts with AES-GCM', async () => {
    const key = toBase64(randomBytes(32));
    const enc = await encryptString('JBSWY3DPEHPK3PXP', key);
    expect(enc).not.toContain('JBSWY3DP');
    expect(await decryptString(enc, key)).toBe('JBSWY3DPEHPK3PXP');
    await expect(decryptString(enc, toBase64(randomBytes(32)))).rejects.toThrow();
  });
  it('generated passwords satisfy the policy', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(16);
      expect(p).toHaveLength(16);
      expect(/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p)).toBe(true);
    }
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  it('base32 round-trips', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(new TextDecoder().decode(base32Decode(secret))).toBe('12345678901234567890');
  });
  it('matches the RFC test vectors (last 6 digits)', async () => {
    expect(await totpCode(secret, 59_000)).toBe('287082');
    expect(await totpCode(secret, 1111111109_000)).toBe('081804');
    expect(await totpCode(secret, 2000000000_000)).toBe('279037');
  });
  it('accepts ±1 step and rejects others', async () => {
    const t = 1_700_000_000_000;
    expect(await verifyTotp(secret, await totpCode(secret, t - 30_000), t)).toBe(true);
    expect(await verifyTotp(secret, await totpCode(secret, t - 90_000), t)).toBe(false);
    expect(await verifyTotp(secret, 'abc123', t)).toBe(false);
  });
});
