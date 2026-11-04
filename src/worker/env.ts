export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** private R2 bucket with employee photographs (metadata in D1 employee_avatars) */
  AVATARS: R2Bucket;
  APP_NAME: string;
  APP_BASE_PATH: string;
  /** secret: base64 key (>= 32 bytes) used to encrypt TOTP secrets */
  MFA_ENCRYPTION_KEY?: string;
}

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  employeeId: number | null;
  roles: string[];
  permissions: string[];
  privileged: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  mfaPending: boolean;
  sessionId: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { user: AuthUser | null };
}
