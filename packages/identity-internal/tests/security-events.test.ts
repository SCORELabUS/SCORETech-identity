import { describe, it, expect, vi } from 'vitest';
import { KeycloakAdminClient } from '../src/keycloak-client.js';
import { describeDevice } from '../src/device.js';
const json = (value: unknown) => new Response(JSON.stringify(value));
function fixture(responses: unknown[]) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ access_token: 'fixture', expires_in: 300 }));
  for (const response of responses) request.mockResolvedValueOnce(json(response));
  return {
    request,
    client: new KeycloakAdminClient({
      issuer: 'https://identity.test/realms/test',
      adminUrl: 'https://identity.test',
      realm: 'test',
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetchImplementation: request,
    }),
  };
}
describe('security event projection', () => {
  it('queries the selected user and strips sensitive event details', async () => {
    const { client, request } = fixture([
      { eventsEnabled: true },
      [
        {
          time: 1,
          type: 'LOGIN',
          userId: 'owner',
          sessionId: 'session',
          details: {
            user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140.0.0.0 Safari/537.36',
            code_id: 'secret',
            redirect_uri: 'secret',
          },
        },
      ],
    ]);
    const result = await client.listSecurityEvents({ user: 'owner', max: 100 });
    expect(String(request.mock.calls[2][0])).toContain('user=owner');
    expect(result.events[0]).toMatchObject({
      browser: 'Chrome 140',
      operatingSystem: 'macOS',
      device: 'Desktop',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.events[0]).not.toHaveProperty('details');
  });
  it('distinguishes disabled recording from an empty history', async () => {
    const { client, request } = fixture([{ eventsEnabled: false }]);
    expect(await client.listSecurityEvents({})).toMatchObject({ enabled: false, events: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('applies search before pagination across provider pages and keeps native filters', async () => {
    const firstPage = Array.from({ length: 100 }, (_, time) => ({
      time,
      type: 'LOGIN',
      clientId: 'other',
    }));
    const { client, request } = fixture([
      { eventsEnabled: true },
      firstPage,
      [
        { time: 101, type: 'LOGIN', clientId: 'sphere-one' },
        { time: 102, type: 'LOGIN', clientId: 'SPHERE-two', details: { code_id: 'private-value' } },
        { time: 103, type: 'LOGIN', clientId: 'sphere-three' },
        { time: 104, type: 'LOGIN', clientId: 'other' },
      ],
    ]);
    const result = await client.listSecurityEvents({
      search: ' SPHERE ',
      type: 'LOGIN',
      first: 1,
      max: 2,
    });
    expect(result.events.map((event) => event.time)).toEqual([102, 103]);
    expect(result).toMatchObject({ first: 1, max: 2, enabled: true });
    const url = new URL(String(request.mock.calls[3][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      first: '100',
      max: '100',
      type: 'LOGIN',
    });
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
  it('searches safe visible identifiers and human-readable event names, never arbitrary details', async () => {
    const events = [
      {
        time: 1,
        type: 'LOGIN_ERROR',
        ipAddress: '192.0.2.1',
        userId: 'member-id',
        error: 'invalid_user',
        details: { code_id: 'hidden-secret' },
      },
    ];
    for (const search of [
      'login error',
      '192.0.2.1',
      'member-id',
      'invalid_user',
      'hidden-secret',
    ]) {
      const { client } = fixture([{ eventsEnabled: true }, events]);
      const result = await client.listSecurityEvents({ search });
      expect(result.events).toHaveLength(search === 'hidden-secret' ? 0 : 1);
    }
  });
  it('preserves direct provider pagination when no text search is requested', async () => {
    const { client, request } = fixture([{ eventsEnabled: true }, []]);
    await client.listSecurityEvents({ first: 25, max: 25, client: 'identity-admin-web' });
    const url = new URL(String(request.mock.calls[2][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      first: '25',
      max: '25',
      client: 'identity-admin-web',
    });
  });
  it('refuses oversized searches without returning a misleading partial page', async () => {
    const { client, request } = fixture([{ eventsEnabled: true }]);
    request.mockImplementation(async () =>
      json(Array.from({ length: 100 }, (_, time) => ({ time, type: 'LOGIN' }))),
    );
    await expect(client.listSecurityEvents({ search: 'absent' })).rejects.toMatchObject({
      status: 503,
      code: 'events_search_limit',
    });
    expect(request).toHaveBeenCalledTimes(1002);
  });
  it('does not invent device data and distinguishes mobile Safari from Chrome', () => {
    expect(describeDevice()).toEqual({});
    expect(describeDevice('Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1')).toMatchObject({
      browser: 'Safari 18',
      operatingSystem: 'iOS',
      device: 'Mobile',
    });
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Edg/140.0')).toMatchObject({
      browser: 'Edge 140',
      operatingSystem: 'Windows',
    });
  });
});
