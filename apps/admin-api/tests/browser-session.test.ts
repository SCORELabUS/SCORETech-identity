import { expect, it, vi } from 'vitest';
import { createSessionAccess } from '../../../packages/ui/src/session.js';

const user = (access_token = 'old', expired = false) => ({ access_token, expired });
function fixture() {
  let current: ReturnType<typeof user> | null = user();
  const manager = {
    getUser: vi.fn(async () => current),
    signinSilent: vi.fn(async () => {
      current = user('new');
      return current;
    }),
    removeUser: vi.fn(async () => {
      current = null;
    }),
  };
  return {
    manager,
    set: (value: typeof current) => {
      current = value;
    },
  };
}
it('coalesces explicit, timed and expired API renewals into one exchange', async () => {
  const f = fixture();
  f.set(user('old', true));
  let finish = (value: ReturnType<typeof user>) => {
    f.set(value);
  };
  f.manager.signinSilent.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = (value) => {
          f.set(value);
          resolve(value);
        };
      }),
  );
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  const session = createSessionAccess(f.manager, fetcher);
  const first = session.renew(),
    second = session.renew(),
    request = session.request('/me', {});
  await vi.waitFor(() => expect(f.manager.signinSilent).toHaveBeenCalledOnce());
  finish(user('new'));
  await Promise.all([first, second, request]);
  expect(f.manager.removeUser).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer new');
});
it('retries a late 401 with the already renewed token without logging out or refreshing again', async () => {
  const f = fixture();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(async () => {
      f.set(user('new'));
      return new Response('', { status: 401 });
    })
    .mockResolvedValueOnce(new Response('{}'));
  const response = await createSessionAccess(f.manager, fetcher).request('/me', {});
  expect(response.status).toBe(200);
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  expect(f.manager.signinSilent).not.toHaveBeenCalled();
  expect(f.manager.removeUser).not.toHaveBeenCalled();
});
it('renews once for an expired/rejected access token and preserves a successful session', async () => {
  const f = fixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockResolvedValueOnce(new Response('{}'));
  expect((await createSessionAccess(f.manager, fetcher).request('/me', {})).status).toBe(200);
  expect(f.manager.signinSilent).toHaveBeenCalledOnce();
  expect(f.manager.removeUser).not.toHaveBeenCalled();
});
it('retains the session on a transient renewal failure and permits the next renewal', async () => {
  const f = fixture();
  f.manager.signinSilent.mockRejectedValueOnce(new TypeError('Network unavailable'));
  const session = createSessionAccess(f.manager);
  await expect(session.renew()).rejects.toThrow('Network unavailable');
  expect(f.manager.removeUser).not.toHaveBeenCalled();
  expect((await session.renew()).access_token).toBe('new');
});
it('clears a definitively revoked refresh session but never clears a newer sign-in', async () => {
  const f = fixture();
  f.manager.signinSilent.mockRejectedValueOnce({ error: 'invalid_grant' });
  const session = createSessionAccess(f.manager);
  await expect(session.renew()).rejects.toMatchObject({ error: 'invalid_grant' });
  expect(f.manager.removeUser).toHaveBeenCalledOnce();
  f.set(user('another-sign-in'));
  f.manager.signinSilent.mockImplementationOnce(async () => {
    f.set(user('latest-sign-in'));
    throw { error: 'invalid_grant' };
  });
  await expect(session.renew()).rejects.toMatchObject({ error: 'invalid_grant' });
  expect(f.manager.removeUser).toHaveBeenCalledOnce();
});
it('removes a session only when its current renewed token is also rejected', async () => {
  const f = fixture();
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
  expect((await createSessionAccess(f.manager, fetcher).request('/me', {})).status).toBe(401);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(f.manager.removeUser).toHaveBeenCalledOnce();
});
it('does not renew or discard sessions on a permission denial', async () => {
  const f = fixture();
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
  expect((await createSessionAccess(f.manager, fetcher).request('/me', {})).status).toBe(403);
  expect(f.manager.signinSilent).not.toHaveBeenCalled();
  expect(f.manager.removeUser).not.toHaveBeenCalled();
});
