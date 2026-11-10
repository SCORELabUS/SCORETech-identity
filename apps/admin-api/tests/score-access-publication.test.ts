import { describe, expect, it, vi } from 'vitest';
import { ProviderCatalogueClient } from '@scoretech/identity-internal';
import { loadConfig } from '../src/main/config/app-config.js';
import { CatalogueService } from '../src/main/modules/catalogue/catalogue-service.js';
import { assertCatalogueDelegation } from '../src/main/modules/catalogue/catalogue.routes.js';
import { validateCatalogue } from '../src/main/modules/catalogue/catalogue-model.js';
const config = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:18000',
  APP_KEYCLOAK_ISSUER: 'https://identity.test/realms/score',
  APP_KEYCLOAK_ADMIN_URL: 'http://provider:8080',
  APP_KEYCLOAK_REALM: 'score',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture',
  APP_IDENTITY_ENVIRONMENT: 'local',
});
const base = 'a'.repeat(64);
function fixture() {
  const catalogue = validateCatalogue({
    permissions: [
      { name: 'identity:roles:manage', description: 'Manage' },
      { name: 'sphere:read', description: 'Read' },
    ],
    roles: [
      {
        name: 'administrador',
        description: 'Admin',
        permissions: ['identity:roles:manage', 'sphere:read'],
      },
      { name: 'member', description: 'Member', permissions: [] },
      { name: 'reader', description: 'Reader', permissions: ['sphere:read'] },
    ],
    groups: [],
    defaultRole: 'member',
  });
  const registry = {
    environment: 'local',
    revision: base,
    generation: 1,
    permissions: catalogue.permissions.map((permission) => ({
      ...permission,
      owner: 'service-owner',
    })),
    roles: catalogue.roles,
    groups: [],
    clientTokenScopes: [
      {
        clientId: 'identity-admin-web',
        enabled: true,
        permissions: catalogue.permissions.map((permission) => permission.name),
      },
      { clientId: 'other-service', enabled: true, permissions: ['sphere:read'] },
    ],
    managedAccessClients: [],
    accessRules: [],
  };
  const request = vi.fn(
    async (
      path = '',
      method = 'GET',
      body?: { registry: typeof registry; actor: string; reason: string; type: string },
    ) => {
      if (method === 'POST')
        return {
          id: body!.registry.revision,
          createdAt: new Date().toISOString(),
          actor: body!.actor,
          reason: body!.reason,
          type: body!.type,
          environments: ['local'],
          revisions: { local: body!.registry.revision },
        };
      if (path.startsWith('/revisions/')) return { catalogue: structuredClone(catalogue) };
      return structuredClone({ catalogue, registry });
    },
  );
  const provider = {
    request,
    projection: vi
      .fn()
      .mockResolvedValue({ permissions: ['sphere:read'], roles: ['member', 'reader'] }),
  };
  const service = new CatalogueService(config, provider as unknown as ProviderCatalogueClient);
  return { service, request, provider, catalogue, registry };
}
describe('database catalogue publication', () => {
  it('reads native state and live assignment roles without GitHub or projection files', async () => {
    const f = fixture();
    expect((await f.service.current()).baseSha).toBe(base);
    expect(await f.service.assignmentRoles('local')).toEqual(['member', 'reader']);
    expect((await f.service.status('local')).state).toBe('applied');
    await expect(f.service.current('production')).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a stale editor before writing', async () => {
    const f = fixture();
    await expect(
      f.service.publish('b'.repeat(64), f.catalogue, 'Change role reason', 'actor'),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.request.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
  });
  it('derives Admin coverage and preserves unrelated service contracts and permission ownership', async () => {
    const f = fixture();
    const next = structuredClone(f.catalogue);
    next.permissions.push({ name: 'space:admin', description: 'Administer SPACE' });
    await f.service.publish(base, next, 'Add SPACE permission', 'actor');
    const body = f.request.mock.calls.find((call) => call[1] === 'POST')![2]!;
    expect(
      body.registry.roles.find((role) => role.name === 'administrador')!.permissions,
    ).toContain('space:admin');
    expect(
      body.registry.permissions.find((permission) => permission.name === 'sphere:read')!.owner,
    ).toBe('service-owner');
    expect(
      body.registry.clientTokenScopes.find((scope) => scope.clientId === 'other-service')!
        .permissions,
    ).toEqual(['sphere:read']);
    expect(body.registry.generation).toBe(2);
  });
  it('keeps retired native role IDs but excludes them from the active catalogue', async () => {
    const f = fixture();
    const next = structuredClone(f.catalogue);
    next.roles = next.roles.filter((role) => role.name !== 'reader');
    await f.service.publish(base, next, 'Remove reader role', 'actor');
    const body = f.request.mock.calls.find((call) => call[1] === 'POST')![2]!;
    expect(body.registry.roles.find((role) => role.name === 'reader')!.permissions).toEqual([]);
    expect((body as unknown as { roleNames: string[] }).roleNames).not.toContain('reader');
  });
  it('does not take over service-owned client scopes', async () => {
    const f = fixture();
    const next = structuredClone(f.catalogue);
    next.accessRules = [
      {
        id: 'sphere',
        clientId: 'other-service',
        origin: 'https://sphere.example.org',
        requiredPermissions: ['sphere:read'],
      },
    ];
    await expect(
      f.service.publish(base, next, 'Add application rule', 'actor'),
    ).rejects.toMatchObject({ code: 'service_owned_client' });
    expect(f.request.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
  });
  it.each(['publish', 'rollback'])('runs delegation checks before a %s write', async (type) => {
    const f = fixture();
    const deny = vi.fn(() => {
      throw Object.assign(new Error('Denied'), { status: 403 });
    });
    const promise =
      type === 'publish'
        ? f.service.publish(
            base,
            f.catalogue,
            'Change role reason',
            'actor',
            ['local'],
            'local',
            deny,
          )
        : f.service.rollback(base, 'b'.repeat(64), ['local'], 'Restore role reason', 'actor', deny);
    await expect(promise).rejects.toMatchObject({ status: 403 });
    expect(deny).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
  });
  it('checks live and signed grants before saving, including inherited grants', async () => {
    const f = fixture();
    const next = structuredClone(f.catalogue);
    next.roles.push({ name: 'elevated', description: 'Elevated', permissions: ['sphere:read'] });
    await expect(
      f.service.publish(
        base,
        next,
        'Attempt role escalation',
        'actor',
        ['local'],
        'local',
        (next, prior) =>
          assertCatalogueDelegation(
            { roles: ['identity:roles:manage'], effectiveRoleNames: ['identity:roles:manage'] },
            next,
            prior,
          ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.request.mock.calls.some((call) => call[1] === 'POST')).toBe(false);
  });
});
