import type { AuthUser } from '../env';
import type { CompanyOption, CompanyScope } from '../../shared/types';
import { can } from '../auth';
import { forbidden } from './http';

/**
 * Companies a user may pick as the active company. Data access in this system is organisation-wide
 * (employees.all) or limited to the user's own records, so the company list follows the same rule.
 */
export async function companyScope(db: D1Database, user: AuthUser): Promise<CompanyScope> {
  const own = user.employeeId === null
    ? null
    : await db.prepare('SELECT c.id, c.code, c.name FROM companies c JOIN employees e ON e.company_id = c.id WHERE e.id = ?').bind(user.employeeId).first<CompanyOption>();
  if (can(user, 'employees.all')) {
    const { results } = await db.prepare('SELECT id, code, name FROM companies WHERE active = 1 ORDER BY code').all<CompanyOption>();
    return { scope: 'all', items: results, ownCompanyId: own?.id ?? null };
  }
  if (own) return { scope: 'own', items: [own], ownCompanyId: own.id };
  return { scope: 'none', items: [], ownCompanyId: null };
}

/** Resolves a requested company id; a company outside the user's scope is rejected, never silently widened. */
export async function requireCompany(db: D1Database, user: AuthUser, raw: string | undefined): Promise<CompanyOption | null> {
  if (raw === undefined || raw === '') return null;
  const id = Number(raw);
  const company = Number.isInteger(id) && id > 0 ? (await companyScope(db, user)).items.find((c) => c.id === id) : undefined;
  if (!company) throw forbidden('ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
  return company;
}
