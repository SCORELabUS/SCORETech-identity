import { expect, it, vi } from 'vitest';
import { supportAssurance } from '../src/main/modules/identity/support-assurance.js';
import type { IdentityAdminClient } from '../src/main/modules/identity/types.js';

it('does not authorize if the five-minute window expires while checking the live session', async () => {
  const now = 1800000000000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const client = {
    listSessions: async () => {
      clock.mockReturnValue(now + 300001);
      return [{ id: 'session' }];
    },
  } as unknown as IdentityAdminClient;
  try {
    expect(
      await supportAssurance(
        {
          subject: 'actor',
          roles: [],
          sessionId: 'session',
          authTime: now / 1000,
          authenticationMethod: 'webauthn-passwordless',
        },
        client,
      ),
    ).toEqual({ verified: false, expiresAt: null });
  } finally {
    clock.mockRestore();
  }
});
