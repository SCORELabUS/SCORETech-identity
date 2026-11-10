import { describe, expect, it, vi } from 'vitest';
import { ProviderCatalogueClient } from '@scoretech/identity-internal';
const config = {
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/realms/score',
  APP_KEYCLOAK_ADMIN_CLIENT_ID: 'identity-admin-service',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'private-service-key',
};
describe('native catalogue transport fails closed', () => {
  it('uses server transport and keeps service credentials out of browser responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'private-service-token', expires_in: 300 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ permissions: ['sphere:read'], roles: ['member'] })),
      );
    const client = new ProviderCatalogueClient(
      { ...config, APP_KEYCLOAK_TRANSPORT_URL: 'http://provider:8080/realms/score' },
      fetcher,
    );
    expect(await client.projection()).toEqual({ permissions: ['sphere:read'], roles: ['member'] });
    expect(fetcher.mock.calls[0]![0]).toBe(
      'http://provider:8080/realms/score/protocol/openid-connect/token',
    );
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe('Bearer private-service-token');
  });
  it.each([400, 401, 403, 404, 409, 500, 503])(
    'does not consume failed provider state (%i)',
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'private-service-token', expires_in: 300 })),
        )
        .mockResolvedValueOnce(new Response('sensitive-provider-detail', { status }));
      const client = new ProviderCatalogueClient(config, fetcher);
      await expect(client.request()).rejects.toMatchObject({
        status: status === 409 ? 409 : status === 404 ? 404 : status === 400 ? 422 : 503,
      });
    },
  );
  it('does not proceed after failed service authentication', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret-debug-data', { status: 401 }));
    const client = new ProviderCatalogueClient(config, fetcher);
    await expect(client.request()).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
