import { readFileSync } from 'node:fs';
/** Docker secrets are read server-side, never returned in public configuration. */
export function secretEnvironment(environment: Record<string, string | undefined>) {
  const result = { ...environment };
  for (const key of ['APP_KEYCLOAK_ADMIN_CLIENT_SECRET']) {
    const file = environment[key + '_FILE'];
    if (file) {
      if (environment[key]) throw new Error(`Configure either ${key} or ${key}_FILE.`);
      result[key] = readFileSync(file, 'utf8').trim();
    }
  }
  return result;
}
