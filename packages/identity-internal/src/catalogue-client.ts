import { z } from 'zod';
import { HttpError } from './errors.js';

/** Private native catalogue access. Service credentials and tokens never leave the backend. */
export class ProviderCatalogueClient {
  private token?: { value: string; expires: number };
  private readonly base: string;
  constructor(
    private readonly config: {
      APP_KEYCLOAK_ISSUER: string;
      APP_KEYCLOAK_TRANSPORT_URL?: string;
      APP_KEYCLOAK_ADMIN_CLIENT_ID: string;
      APP_KEYCLOAK_ADMIN_CLIENT_SECRET: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = (config.APP_KEYCLOAK_TRANSPORT_URL ?? config.APP_KEYCLOAK_ISSUER).replace(
      /\/$/,
      '',
    );
  }
  async request(path = '', method = 'GET', body?: unknown): Promise<unknown> {
    if (!this.token || this.token.expires <= Date.now()) {
      const response = await this.fetcher(this.base + '/protocol/openid-connect/token', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
          client_secret: this.config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
        }),
      });
      if (!response.ok)
        throw new HttpError(503, 'catalogue_unavailable', 'The identity catalogue is unavailable.');
      const token = z
        .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
        .parse(await response.json());
      this.token = {
        value: token.access_token,
        expires: Date.now() + Math.max(0, token.expires_in - 30) * 1000,
      };
    }
    const response = await this.fetcher(this.base + '/score-catalogue' + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + this.token.value, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      throw new HttpError(
        response.status === 409
          ? 409
          : response.status === 404
            ? 404
            : response.status === 400
              ? 422
              : 503,
        response.status === 409 ? 'stale_catalogue' : 'catalogue_unavailable',
        response.status === 409
          ? 'The catalogue has changed. Reload before saving.'
          : 'The identity provider could not complete the catalogue operation.',
      );
    }
    return response.json();
  }
  async projection() {
    return z
      .object({ permissions: z.array(z.string()), roles: z.array(z.string()) })
      .strict()
      .parse(await this.request('/projection'));
  }
}
