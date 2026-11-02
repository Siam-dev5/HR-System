#!/usr/bin/env node
// Creates (or resets) a user with a random password and writes the SQL to a file for `wrangler d1 execute`.
// The password is written ONLY to the credentials file given with --cred-file (default .secrets/credentials.txt,
// git-ignored) and is never printed.
//
// Usage:
//   node scripts/create-user.mjs --username admin --display "System Administrator" --role super_admin \
//        [--role hr_admin] [--employee E002] [--must-change] [--out .tmp/user.sql] [--cred-file .secrets/credentials.txt]
//   npx wrangler d1 execute hr-system-db --local --file .tmp/user.sql
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { generatePassword, hashPassword, sqlString } from './lib/password.mjs';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    display: { type: 'string' },
    role: { type: 'string', multiple: true, default: [] },
    employee: { type: 'string' },
    'must-change': { type: 'boolean', default: false },
    out: { type: 'string', default: '.tmp/create-user.sql' },
    'cred-file': { type: 'string', default: '.secrets/credentials.txt' },
    label: { type: 'string', default: '' },
  },
});

if (!values.username || !/^[a-zA-Z0-9._-]{3,50}$/.test(values.username)) {
  console.error('--username is required (a-z 0-9 . _ -, 3-50 chars)');
  process.exit(1);
}
const password = process.env.NEW_USER_PASSWORD || generatePassword(20);
const hash = await hashPassword(password);
const u = sqlString(values.username);

const sql = [
  `INSERT INTO users (username, display_name, password_hash, must_change_password) VALUES (${u}, ${sqlString(values.display ?? values.username)}, ${sqlString(hash)}, ${values['must-change'] ? 1 : 0})`,
  `  ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, must_change_password = excluded.must_change_password, failed_attempts = 0, locked_until = NULL, active = 1;`,
  ...values.role.map((r) => `INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = ${u} AND r.code = ${sqlString(r)};`),
  values.employee ? `UPDATE employees SET user_id = (SELECT id FROM users WHERE username = ${u}) WHERE emp_code = ${sqlString(values.employee)} AND user_id IS NULL;` : '',
].filter(Boolean).join('\n');

mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, sql + '\n');
mkdirSync(dirname(values['cred-file']), { recursive: true });
appendFileSync(values['cred-file'], `${values.label ? `[${values.label}] ` : ''}username=${values.username} password=${password} roles=${values.role.join(',') || '-'}${values.employee ? ` employee=${values.employee}` : ''}\n`, { mode: 0o600 });
console.log(`SQL written to ${values.out}; credentials appended to ${values['cred-file']} (keep private).`);
