import { describe, it, expect, vi } from 'vitest';
import { KeycloakAdminClient } from '../src/keycloak-client.js';
const role = { id: 'role-commercial', name: 'comercial', composite: false };
const parent = { id: 'role-lead', name: 'responsable', composite: true };
const user = (id: string, enabled = true) => ({ id, enabled, emailVerified: true, firstName: id });
// eslint-disable-next-line no-unused-vars -- Type-only callback parameter.
function fixture(resolve: (url: URL) => unknown) {
  const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/token'))
      return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 300 }));
    return new Response(JSON.stringify(resolve(parsed)));
  });
  return {
    fetchImplementation,
    client: new KeycloakAdminClient({
      issuer: 'https://identity.test/realms/test',
      adminUrl: 'https://identity.test',
      realm: 'test',
      clientId: 'fixture',
      clientSecret: 'fixture',
      managedRoles: ['comercial', 'responsable'],
      fetchImplementation,
    }),
  };
}
describe('effective commercial role directory', () => {
  it('finds direct, composite, group and subgroup users without scanning accounts', async () => {
    const { client, fetchImplementation } = fixture((url) => {
      const p = url.pathname.replace('/admin/realms/test', '');
      if (p === '/roles') return [role, parent];
      if (p === '/roles-by-id/role-lead/composites') return [role];
      if (p === '/roles/comercial/users')
        return [user('direct'), user('disabled', false), user('stale')];
      if (p === '/roles/responsable/users') return [user('composite'), user('direct')];
      if (p === '/roles/comercial/groups') return [{ id: 'g1' }];
      if (p === '/roles/responsable/groups') return [];
      if (p === '/groups/g1/members') return [user('group')];
      if (p === '/groups/g1/children') return [{ id: 'g2' }];
      if (p === '/groups/g2/members') return [user('subgroup')];
      if (p === '/groups/g2/children') return [];
      if (p.includes('/role-mappings/realm/composite')) return p.includes('/stale/') ? [] : [role];
      throw Error('Unexpected directory request ' + p);
    });
    expect((await client.listEffectiveRoleUsers(['comercial'])).map((u) => u.id).sort()).toEqual([
      'composite',
      'direct',
      'group',
      'subgroup',
    ]);
    expect(
      fetchImplementation.mock.calls.some(
        ([url]) => new URL(String(url)).pathname === '/admin/realms/test/users',
      ),
    ).toBe(false);
  });
  it('paginates more than100 directly assigned members', async () => {
    const users = Array.from({ length: 101 }, (_, i) => user('member-' + i));
    const { client } = fixture((url) => {
      const p = url.pathname.replace('/admin/realms/test', '');
      if (p === '/roles') return [role];
      if (p === '/roles/comercial/users')
        return users.slice(
          Number(url.searchParams.get('first')),
          Number(url.searchParams.get('first')) + 100,
        );
      if (p === '/roles/comercial/groups') return [];
      if (p.includes('/role-mappings/realm/composite')) return [role];
      throw Error('Unexpected request');
    });
    expect(await client.listEffectiveRoleUsers(['comercial'])).toHaveLength(101);
  });
  it('fails explicitly if the provider repeats a full page', async () => {
    const repeated = Array.from({ length: 100 }, (_, i) => user('member-' + i));
    const { client } = fixture((url) =>
      url.pathname.endsWith('/roles') ? [role] : url.pathname.endsWith('/users') ? repeated : [],
    );
    await expect(client.listEffectiveRoleUsers(['comercial'])).rejects.toThrow(/partial listing/);
  });
  it('rejects a role outside the promoted catalogue before contacting the provider', async () => {
    const { client, fetchImplementation } = fixture(() => []);
    await expect(client.listEffectiveRoleUsers(['unmanaged'])).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
