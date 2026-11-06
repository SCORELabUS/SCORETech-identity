import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/main/config/app-config.js';
import { assertAppliedAuthorization } from '../src/main/shared/mutation-guard.js';

const previousRevision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'score-applied-authorization-'));
  directories.push(directory);
  const statePath = join(directory, 'apply-status.json');
  const registryPath = join(directory, 'active-registry.json');
  const config = loadConfig({
    APP_CORS_ORIGINS: 'http://localhost:18000',
    APP_KEYCLOAK_ISSUER: 'https://identity.example.test/identity/auth/realms/score',
    APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080/identity/auth',
    APP_KEYCLOAK_REALM: 'score',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture-only',
    APP_IDENTITY_ENVIRONMENT: 'local',
    APP_AUTHORIZATION_CATALOGUE_PATH: join(directory, 'catalogue.json'),
    APP_CATALOGUE_STATE_PATH: statePath,
  });
  const status = (state = 'applied', observedRevision = previousRevision) =>
    writeFileSync(
      statePath,
      JSON.stringify({ state, desiredRevision: observedRevision, observedRevision }),
    );
  const registry = (revision = previousRevision) =>
    writeFileSync(
      registryPath,
      JSON.stringify({
        environment: 'local',
        generation: revision === previousRevision ? 1 : 2,
        revision,
        permissions: [],
        roles: [{ name: 'member', permissions: [] }],
      }),
    );
  const allowed = () => expect(() => assertAppliedAuthorization(config)).not.toThrow();
  const denied = () =>
    expect(() => assertAppliedAuthorization(config)).toThrowError(
      expect.objectContaining({ status: 503, code: 'catalogue_not_applied' }),
    );
  status();
  registry();
  return { config, statePath, registryPath, status, registry, allowed, denied };
}

describe('verified authorization application boundary', () => {
  it('permits a fully applied status matching the complete active registry', () => {
    fixture().allowed();
  });

  it('blocks the whole native-commit and failed-verification window until confirmed recovery', () => {
    const f = fixture();
    f.allowed();

    // The reconciler announces applying before sending the native provider PUT.
    f.status('applying');
    f.denied();

    // The provider committed the new DAG, but verification failed. The old
    // projection must no longer authorize assignment of a newly privileged role.
    writeFileSync(
      f.statePath,
      JSON.stringify({
        state: 'failed',
        desiredRevision: nextRevision,
        observedRevision: previousRevision,
        detail: 'Verification timed out after the provider committed the new registry.',
      }),
    );
    f.denied();

    // Retrying and publishing a fresh projection alone is insufficient: the
    // final verified status must also be published before mutations resume.
    f.status('applying', nextRevision);
    f.registry(nextRevision);
    f.denied();
    f.status('applied', nextRevision);
    f.allowed();
  });

  it.each(['applying', 'failed', 'pending', 'unknown'])(
    'blocks %s even when both documents contain the same revision',
    (state) => {
      const f = fixture();
      f.status(state);
      f.denied();
    },
  );

  it.each(['status', 'registry'])(
    'blocks an applied marker paired with a stale %s revision',
    (changed) => {
      const f = fixture();
      if (changed === 'status') f.status('applied', nextRevision);
      else f.registry(nextRevision);
      f.denied();
    },
  );

  it.each(['status', 'registry'])(
    'blocks a missing %s document instead of trusting the remaining document',
    (missing) => {
      const f = fixture();
      rmSync(missing === 'status' ? f.statePath : f.registryPath);
      f.denied();
    },
  );

  it.each([
    ['status', '{'],
    ['status', 'null'],
    ['status', '{}'],
    ['registry', '{'],
    ['registry', 'null'],
    ['registry', '{}'],
  ])('blocks malformed or incomplete %s document (%s)', (changed, content) => {
    const f = fixture();
    writeFileSync(changed === 'status' ? f.statePath : f.registryPath, content);
    f.denied();
  });

  it.each(['', 'not-a-revision', 'a'.repeat(63), 'g'.repeat(64)])(
    'rejects matching revision strings that are not complete snapshot digests (%j)',
    (revision) => {
      const f = fixture();
      f.status('applied', revision);
      f.registry(revision);
      f.denied();
    },
  );
});
