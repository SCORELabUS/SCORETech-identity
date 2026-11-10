interface SessionUser {
  access_token: string;
  expired?: boolean;
  expires_in?: number;
}

export function sessionRejected(error: unknown): boolean {
  const code = (error as { error?: string } | null)?.error;
  return [
    "invalid_grant",
    "login_required",
    "interaction_required",
    "consent_required",
    "account_selection_required",
    "access_denied",
    "invalid_token",
  ].includes(code ?? "");
}

// Every renewal in this console shares one refresh-token exchange. In particular,
// the expiry timer, API calls and explicit role/catalogue renewals cannot race.
export function createSessionAccess<T extends SessionUser>(
  manager: {
    getUser(): Promise<T | null>;
    signinSilent(): Promise<T | null>;
    removeUser(): Promise<void>;
    recover?(before: T): Promise<T | null>;
  },
  fetcher: typeof fetch = fetch,
) {
  let renewing: Promise<T> | undefined;
  function renew(): Promise<T> {
    if (!renewing) {
      renewing = (async () => {
        const before = await manager.getUser();
        try {
          const user = await manager.signinSilent();
          if (!user || user.expired)
            throw Object.assign(
              new Error("Your session has expired. Sign in again."),
              { error: "login_required" },
            );
          return user;
        } catch (initialError) {
          let error = initialError;
          const current = await manager.getUser();
          if (
            before &&
            manager.recover &&
            sessionRejected(error) &&
            current?.access_token === before.access_token
          ) {
            try {
              const recovered = await manager.recover(before);
              if (recovered && !recovered.expired) return recovered;
              error = Object.assign(
                new Error("Your session has ended. Sign in again."),
                { error: "login_required" },
              );
            } catch (cause) {
              error = cause;
            }
          }
          const latest = await manager.getUser();
          if (
            sessionRejected(error) &&
            (!latest || latest.access_token === before?.access_token)
          )
            await manager.removeUser();
          throw error;
        }
      })().finally(() => {
        renewing = undefined;
      });
    }
    return renewing;
  }
  async function request(
    path: string,
    options: RequestInit,
  ): Promise<Response> {
    let user = renewing ? await renewing : await manager.getUser();
    if (!user) throw new Error("Your session has expired. Sign in again.");
    if (user.expired) user = await renew();
    const send = (current: T) =>
      fetcher(path, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: "Bearer " + current.access_token,
        },
      });
    let response = await send(user);
    if (response.status === 401) {
      const latest = renewing ? await renewing : await manager.getUser();
      if (!latest) return response;
      user =
        latest.access_token !== user.access_token && !latest.expired
          ? latest
          : await renew();
      response = await send(user);
      if (
        response.status === 401 &&
        (await manager.getUser())?.access_token === user.access_token
      )
        await manager.removeUser();
    }
    return response;
  }
  async function resume(): Promise<T | null> {
    if (renewing) return renewing;
    const user = await manager.getUser();
    return user &&
      (user.expired || (user.expires_in !== undefined && user.expires_in <= 60))
      ? renew()
      : user;
  }
  return { renew, request, resume };
}
