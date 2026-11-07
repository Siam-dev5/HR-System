// Which company a row of an import belongs to. The company is never guessed from an employee-code prefix (codes of one
// company may start like another's): it comes either from the company the user chose (one file per company) or, for a
// file that mixes companies, from an explicit rule — a column of the file whose values HR has matched to companies
// (a "Company" column, or e.g. "Group" / "Department"). A value without a match leaves the row without a company.
import type { Cell } from './xlsx';

export type CompanyMode = 'single' | 'combined';
export interface CompanyRef {
  id: number;
  code: string;
  name: string;
}
/** column of the file + its values matched to company ids (keys are normalised values) */
export interface CompanyRule {
  column: number | null;
  values: Record<string, number | null>;
}

/** Values are compared trimmed, with runs of spaces collapsed and without case. */
export const companyKey = (v: Cell | undefined): string => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The one company whose id, code or name equals the value exactly; ambiguous when several do. */
export function suggestCompany(value: string, companies: readonly CompanyRef[]): { id: number | null; ambiguous: boolean } {
  const k = companyKey(value);
  if (!k) return { id: null, ambiguous: false };
  const hits = companies.filter((c) => [String(c.id), c.code, c.name].some((x) => companyKey(x) === k));
  return hits.length === 1 ? { id: hits[0]!.id, ambiguous: false } : { id: null, ambiguous: hits.length > 1 };
}

/** Distinct values of one column under the header (with how many rows carry each), in order of first appearance. */
export function columnValues(grid: readonly Cell[][], headerRow: number, column: number): Array<{ value: string; key: string; rows: number }> {
  const out = new Map<string, { value: string; key: string; rows: number }>();
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (row.every((c) => c === null || String(c).trim() === '')) continue;
    const value = String(row[column] ?? '').trim();
    const key = companyKey(value);
    const hit = out.get(key);
    if (hit) hit.rows++;
    else out.set(key, { value, key, rows: 1 });
  }
  return [...out.values()];
}

export type RowCompany =
  | { state: 'ok'; companyId: number; value: string | null }
  | { state: 'missing'; value: string | null }
  | { state: 'unmatched'; value: string }
  | { state: 'conflict'; companyId: number; value: string };

/**
 * The company of one row. single: the chosen company; a value of the company column that names another company is a
 * conflict, an unmatched value is unmatched, an empty one keeps the chosen company. combined: only the rule decides.
 */
export function rowCompany(mode: CompanyMode, chosen: number | null, rule: CompanyRule | null, row: readonly Cell[]): RowCompany {
  const value = rule && rule.column !== null ? String(row[rule.column] ?? '').trim() : '';
  const mapped = value ? rule!.values[companyKey(value)] : undefined;
  if (mode === 'single') {
    if (!value) return { state: 'ok', companyId: chosen!, value: null };
    if (mapped === undefined || mapped === null) return { state: 'unmatched', value };
    return mapped === chosen ? { state: 'ok', companyId: chosen, value } : { state: 'conflict', companyId: mapped, value };
  }
  if (!value) return { state: 'missing', value: null };
  if (mapped === undefined || mapped === null) return { state: 'unmatched', value };
  return { state: 'ok', companyId: mapped, value };
}

/** Rule from untrusted input: an integer column and value → company id (or null) pairs. */
export function readCompanyRule(v: unknown, maxCols: number): CompanyRule | null {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const column = o.column === null || o.column === undefined || o.column === '' ? null : Number(o.column);
  if (column !== null && (!Number.isInteger(column) || column < 0 || column >= maxCols)) throw new RangeError('คอลัมน์ที่ใช้ระบุบริษัทไม่ถูกต้อง');
  const values: Record<string, number | null> = {};
  const list = Array.isArray(o.values) ? o.values : [];
  if (list.length > 500) throw new RangeError('ค่าที่ใช้ระบุบริษัทมากเกินไป');
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = companyKey((item as Record<string, unknown>).value as Cell);
    const id = (item as Record<string, unknown>).company_id;
    if (!key) continue;
    if (id === null || id === undefined || id === '') values[key] = null;
    else if (Number.isInteger(Number(id)) && Number(id) > 0) values[key] = Number(id);
    else throw new RangeError('บริษัทที่จับคู่ไม่ถูกต้อง');
  }
  return { column, values };
}

export interface EmployeeRef {
  id: number;
  emp_code: string;
  company_id: number;
}
/**
 * The employee with this code in this company. Codes are compared without case; an employee of another company is
 * never returned (the companies holding the code are reported instead, so the row can be refused as a conflict).
 */
export function matchEmployee<E extends EmployeeRef>(employees: readonly E[], companyId: number, code: string): { employee: E } | { elsewhere: number[] } {
  const k = code.trim().toUpperCase();
  const same = employees.filter((e) => e.emp_code.toUpperCase() === k);
  const employee = same.find((e) => e.company_id === companyId);
  return employee ? { employee } : { elsewhere: same.map((e) => e.company_id) };
}
