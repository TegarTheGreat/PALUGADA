/**
 * Connection configuration.
 *
 * Three roles exist and the distinction is a security boundary rather than
 * bookkeeping. `app` is the only one agent code may use: it holds NOBYPASSRLS,
 * so tenant isolation is enforced by PostgreSQL even when a prompt injection
 * convinces an agent to ask for another tenant's data. `admin` holds BYPASSRLS
 * and belongs to the control plane alone. `owner` runs migrations.
 */
export type RoleName = 'app' | 'admin' | 'owner';

const DEFAULTS: Record<RoleName, string> = {
  app: 'postgres://palugada_app:dev_app@127.0.0.1:5432/palugada',
  admin: 'postgres://palugada_admin:dev_admin@127.0.0.1:5432/palugada',
  owner: 'postgres://palugada_owner:dev_owner@127.0.0.1:5432/palugada',
};

const ENV_KEYS: Record<RoleName, string> = {
  app: 'PALUGADA_APP_URL',
  admin: 'PALUGADA_ADMIN_URL',
  owner: 'PALUGADA_OWNER_URL',
};

export function connectionString(role: RoleName): string {
  return process.env[ENV_KEYS[role]] ?? DEFAULTS[role];
}
