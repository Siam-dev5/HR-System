import type { Context } from 'hono';
import type { AppEnv } from '../env';

export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? null;
}

/** Appends an audit entry. Details must never contain secrets or full sensitive values. */
export async function audit(
  c: Context<AppEnv>,
  action: string,
  entity: string | null,
  entityId: string | number | null,
  details?: Record<string, unknown>,
  actor?: { id: number | null; username: string | null },
): Promise<void> {
  const user = c.get('user');
  const who = actor ?? { id: user?.id ?? null, username: user?.username ?? null };
  await c.env.DB.prepare('INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(who.id, who.username, action, entity, entityId === null ? null : String(entityId), details ? JSON.stringify(details) : null, clientIp(c))
    .run();
}

export async function notify(db: D1Database, userId: number, title: string, body: string | null, link: string | null): Promise<void> {
  await db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)').bind(userId, title, body, link).run();
}
