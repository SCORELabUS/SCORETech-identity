import { describe, expect, it, vi } from 'vitest';
import { KeycloakAdminClient } from '../src/keycloak-client.js';
const options = {
  issuer: 'https://identity.test/realms/test',
  adminUrl: 'https://identity.test',
  realm: 'test',
  clientId: 'service',
  clientSecret: 'must-not-be-forwarded',
};
describe('support provider adapter', () => {
  it('forwards only the operator token and confirmation to the provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new KeycloakAdminClient({ ...options, fetchImplementation: fetcher });
    await client.deleteCredential('target/id', 'key/id', 'operator-token', 'Lost device');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://identity.test/realms/test/tentu-support/users/target%2Fid/credentials/key%2Fid',
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer operator-token' },
      body: JSON.stringify({ reason: 'Lost device', confirmed: true }),
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(options.clientSecret);
  });
  it('reserves verification through the shared provider and surfaces rate limits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    const client = new KeycloakAdminClient({ ...options, fetchImplementation: fetcher });
    await expect(client.reserveVerification('target', 'operator-token')).rejects.toMatchObject({
      status: 429,
    });
    expect(String(fetcher.mock.calls[0][0])).toContain(
      '/tentu-support/users/target/verification-request',
    );
  });
});
