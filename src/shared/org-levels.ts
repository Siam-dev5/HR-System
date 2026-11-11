// Position level of the organization chart (presentation only, no schema): an exact Position Title → Level table.
// The table was built from the position titles in use in production (2026-11-10, read-only SELECT) and approved by
// HR. Level and reporting line are separate: the level picks the card's band in the chart, manager_id alone decides
// who reports to whom. A title that is not in the table is NOT guessed from keywords or job grade: it is shown as L5
// with an "Unmapped Level" marker so HR can review it and extend this table.

export type OrgLevel = 1 | 2 | 3 | 4 | 5;

export const ORG_LEVEL_LABELS: Readonly<Record<OrgLevel, string>> = {
  1: 'MD',
  2: 'AMD',
  3: 'Manager',
  4: 'Head / Leader',
  5: 'Staff / Admin',
};

/** Exact production titles (case and spacing as stored; only leading / trailing spaces are ignored). */
export const POSITION_LEVELS: Readonly<Record<string, OrgLevel>> = {
  // L1 MD — the production title is "Manager Director" (kept as stored)
  'Manager Director': 1,
  // L2 AMD
  'Asst. Managing Director': 2,
  // L3 Manager
  'Operations Manager': 3,
  'Account Manager': 3,
  'Human Resources Manager': 3,
  'Partners Manager': 3,
  // L4 Head of Department / Leader
  'Operations Leader': 4,
  'Customer Service Leader': 4,
  'HR Leader (Payroll & Admin)': 4,
  'Leader Graphic Designer': 4,
  'Sales Leader': 4,
  'LiveStreaming Team Leader': 4,
  // L5 Staff / Admin ("Business Development" stays L5 even where the person has reports)
  'Business Development': 5,
  'Customer Service Officer': 5,
  'Graphic Designer': 5,
  'Operations Officer': 5,
  'LiveStreaming': 5,
  'Content Creator Officer': 5,
  'Accountant': 5,
  'Chinese Interpreter': 5,
  'Order Management': 5,
  'Administration Officer': 5,
  'HR Officer (Recruit & Training)': 5,
  'IT Support Officer': 5,
  'Quality Control Officer': 5,
  'Sales Executive': 5,
};

export interface PositionLevel {
  level: OrgLevel;
  /** false = the title is not in the table (or the person has no position): shown as L5 with a marker */
  mapped: boolean;
}

export function positionLevel(title: string | null | undefined): PositionLevel {
  const key = (title ?? '').trim();
  const level = key ? POSITION_LEVELS[key] : undefined;
  return level ? { level, mapped: true } : { level: 5, mapped: false };
}
