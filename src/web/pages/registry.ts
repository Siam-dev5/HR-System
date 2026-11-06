// Maps every non-CRUD module key in src/shared/modules.ts to its screen.
import { renderSecurity } from './auth';
import { renderAnalytics, renderDashboard, renderEss, renderOrganization, renderTalent, renderWorkflowInbox } from './overview';
import { renderMyPayslips, renderPayroll, renderPayslips, renderPayslipView } from './payroll';
import { renderAudit, renderHelp, renderReports, renderRoles, renderSettings, renderUsers } from './system';
import { renderAttendanceImport, renderOtReview } from './attendance';
import { renderPayrollPreview } from './payroll-preview';
import { renderOrgChart } from './org';
import { renderHolidays } from './holidays';
import { renderAttendanceFileHistory, renderAttendanceFileImport } from './attendance-files';
import { renderShiftGroups, renderShiftSchedule, renderShiftSettings } from './shifts';

export type PageRenderer = (main: HTMLElement, params: URLSearchParams) => Promise<void>;

export const PAGES: Record<string, PageRenderer> = {
  dashboard: renderDashboard,
  ess: renderEss,
  my_payslips: renderMyPayslips,
  analytics: renderAnalytics,
  workflow_inbox: renderWorkflowInbox,
  organization: renderOrganization,
  talent: renderTalent,
  holiday_calendar: renderHolidays,
  attendance_file_import: renderAttendanceFileImport,
  attendance_file_history: renderAttendanceFileHistory,
  shift_groups: renderShiftGroups,
  shift_schedule: renderShiftSchedule,
  attendance_import: renderAttendanceImport,
  ot_review: renderOtReview,
  payroll_preview: renderPayrollPreview,
  org_chart: renderOrgChart,
  payroll: renderPayroll,
  payslips: renderPayslips,
  reports: renderReports,
  audit: renderAudit,
  users: renderUsers,
  roles: renderRoles,
  settings: renderSettings,
  security: renderSecurity,
  help: renderHelp,
};

/** CRUD modules whose screen is a dedicated page (their CRUD API, permissions and lookups stay as they are). */
export const CRUD_SCREENS: Record<string, PageRenderer> = {
  shifts: renderShiftSettings,
};

export { renderPayslipView };
