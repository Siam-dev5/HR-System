import { Hono } from 'hono';
import type { AppEnv } from './env';
import type { ApiError } from '../shared/types';
import { HttpError } from './lib/http';
import { sessionMiddleware } from './auth';
import { authRoutes, securityRoutes } from './routes/auth';
import { crudRoutes, lookupRoutes } from './routes/crud';
import { overviewRoutes } from './routes/overview';
import { workflowRoutes } from './routes/workflow';
import { payrollRoutes, payslipRoutes } from './routes/payroll';
import { adminRoutes } from './routes/admin';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  // CSRF: state-changing requests must carry the custom header (forces a CORS preflight, which we never allow)
  // and, when the browser sends Origin, it must be this site.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (c.req.header('x-hr-requested') !== '1' || (origin && origin !== new URL(c.req.url).origin)) {
      throw new HttpError(403, 'csrf', 'คำขอไม่ผ่านการตรวจสอบความปลอดภัย');
    }
  }
  await next();
  c.header('cache-control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'same-origin');
  c.header('x-frame-options', 'DENY');
});

app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'").first<{ tables: number }>();
  return c.json({ ok: true, database: 'd1', tables: row?.tables ?? 0, time: new Date().toISOString() });
});

app.use('/api/*', sessionMiddleware);
app.route('/api/auth', authRoutes);
app.route('/api/security', securityRoutes);
app.route('/api/m', crudRoutes);
app.route('/api/lookup', lookupRoutes);
app.route('/api/workflow', workflowRoutes);
app.route('/api/payroll', payrollRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', payslipRoutes);
app.route('/api', overviewRoutes);

app.all('/api/*', (c) => c.json<ApiError>({ error: { code: 'not_found', message: 'ไม่พบ API ที่ร้องขอ' } }, 404));

// Anything else is the SPA (normally served by the assets layer before the Worker runs).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json<ApiError>({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error('Unhandled error', c.req.method, c.req.path, err);
  return c.json<ApiError>({ error: { code: 'internal', message: 'เกิดข้อผิดพลาดภายในระบบ' } }, 500);
});

export default app;
