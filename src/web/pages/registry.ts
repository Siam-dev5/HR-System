// Maps every non-CRUD module key in src/shared/modules.ts to its screen.
import { renderSecurity } from './auth';
import { renderAnalytics, renderDashboard, renderEss, renderOrganization, renderTalent, renderWorkflowInbox } from './overview';
import { renderMyPayslips, renderPayroll, renderPayslips, renderPayslipView } from './payroll';
import { renderAudit, renderHelp, renderReports, renderRoles, renderSettings, renderUsers } from './system';

export type PageRenderer = (main: HTMLElement, params: URLSearchParams) => Promise<void>;

export const PAGES: Record<string, PageRenderer> = {
  dashboard: renderDashboard,
  ess: renderEss,
  my_payslips: renderMyPayslips,
  analytics: renderAnalytics,
  workflow_inbox: renderWorkflowInbox,
  organization: renderOrganization,
  talent: renderTalent,
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

export { renderPayslipView };
