import { describe, expect, it, vi } from 'vitest';
import { KeycloakAdminClient } from '../src/keycloak-client.js';

const user = (id: string, firstName: string, enabled = true) => ({
  id,
  firstName,
  username: id,
  lastName: 'Muñoz',
  email: `${id}@example.invalid`,
  enabled,
  emailVerified: enabled,
});
function fixture(users: ReturnType<typeof user>[], repeat = false, onRead = () => undefined) {
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 300 });
    if (init?.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1);
      const index = users.findIndex((user) => user.id === id);
      if (index >= 0) users.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (init?.method === 'PATCH') {
      Object.assign(users[0]!, JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    onRead();
    expect(url.pathname).toBe('/admin/realms/test/users');
    expect(url.searchParams.has('search')).toBe(false);
    const first = repeat ? 0 : Number(url.searchParams.get('first'));
    return Response.json(users.slice(first, first + Number(url.searchParams.get('max'))));
  });
  return new KeycloakAdminClient({
    issuer: 'https://identity.test/realms/test',
    adminUrl: 'https://identity.test',
    realm: 'test',
    clientId: 'fixture',
    clientSecret: 'fixture',
    fetchImplementation,
  });
}
describe('accent-insensitive directory search', () => {
  it('folds both stored names and query, including decomposed accents and several terms', async () => {
    const client = fixture([
      user('first', 'José'),
      user('second', 'Jose\u0301'),
      user('third', 'Ana'),
    ]);
    expect((await client.listUsers('JOSE MUNOZ', 0, 10)).map((u) => u.id)).toEqual([
      'first',
      'second',
    ]);
    expect((await client.listUsers('JÓSÉ Muñóz', 0, 10)).map((u) => u.id)).toEqual([
      'first',
      'second',
    ]);
  });
  it('filters before applying offsets across directory pages and returns matching summaries', async () => {
    const users = [
      ...Array.from({ length: 105 }, (_, i) => user(`other-${i}`, 'Ana')),
      user('jose-1', 'José'),
      user('jose-2', 'José', false),
      user('jose-3', 'José'),
    ];
    const client = fixture(users);
    expect((await client.listUsers('jose', 1, 1)).map((u) => u.id)).toEqual(['jose-2']);
    expect(await client.summarizeUsers('jose')).toEqual({
      total: 3,
      enabled: 2,
      emailUnverified: 1,
    });
    expect((await client.listUsers('jose', 0, 10, { enabled: true })).map((u) => u.id)).toEqual([
      'jose-1',
      'jose-3',
    ]);
  });
  it('coalesces list and summary scans and reuses the bounded five-second snapshot', async () => {
    const reads = vi.fn();
    const client = fixture(
      Array.from({ length: 101 }, (_, i) => user(`person-${i}`, 'José')),
      false,
      reads,
    );
    const [listed, summary] = await Promise.all([
      client.listUsers('jose', 0, 10),
      client.summarizeUsers('JOSE'),
    ]);
    expect(listed).toHaveLength(10);
    expect(summary.total).toBe(101);
    expect(reads).toHaveBeenCalledTimes(2);
    await client.listUsers('munoz', 0, 10);
    expect(reads).toHaveBeenCalledTimes(2);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    try {
      await client.listUsers('jose', 0, 10);
    } finally {
      clock.mockRestore();
    }
    expect(reads).toHaveBeenCalledTimes(4);
  });
  it('invalidates snapshots after central deletes and the guarded profile PATCH', async () => {
    const reads = vi.fn();
    const client = fixture([user('first', 'José'), user('second', 'José')], false, reads);
    expect(await client.listUsers('jose', 0, 10)).toHaveLength(2);
    await client.deleteUser('first');
    expect((await client.listUsers('jose', 0, 10)).map((user) => user.id)).toEqual(['second']);
    await client.updateUser('second', { firstName: 'Ana' });
    expect(await client.listUsers('jose', 0, 10)).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(3);
  });
  it('never recaches an in-flight snapshot after a mutation', async () => {
    // eslint-disable-next-line no-unused-vars -- Type-only callback parameter.
    let finish: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/token'))
        return Response.json({ access_token: 'fixture', expires_in: 300 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      reads++;
      return reads === 1 ? pending : Response.json([]);
    });
    const client = new KeycloakAdminClient({
      issuer: 'https://identity.test/realms/test',
      adminUrl: 'https://identity.test',
      realm: 'test',
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetchImplementation,
    });
    const initial = client.listUsers('jose', 0, 10);
    await vi.waitFor(() => expect(reads).toBe(1));
    await client.deleteUser('first');
    finish(Response.json([user('first', 'José')]));
    await initial;
    expect(await client.listUsers('jose', 0, 10)).toHaveLength(0);
    expect(reads).toBe(2);
  });
  it('reports the overall scan deadline without returning partial results', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      await expect(fixture([]).listUsers('jose', 0, 10)).rejects.toMatchObject({
        code: 'user_search_timeout',
      });
    } finally {
      timeout.mockRestore();
    }
  });
  it('rejects a repeated full page instead of returning a partial summary', async () => {
    const client = fixture(
      Array.from({ length: 100 }, (_, i) => user(`person-${i}`, 'José')),
      true,
    );
    await expect(client.summarizeUsers('jose')).rejects.toMatchObject({
      code: 'user_search_pagination_stalled',
    });
  });
});
