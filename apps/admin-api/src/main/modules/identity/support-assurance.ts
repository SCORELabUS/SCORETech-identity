import { HttpError, type Principal } from '@scoretech/identity-internal';
import type { IdentityAdminClient } from './types.js';

// authTime comes only from the signature-verified token, never from the browser.
export async function supportAssurance(principal: Principal, client: IdentityAdminClient) {
  const now = Date.now();
  const expiresAt = (principal.authTime ?? 0) * 1000 + 300_000;
  if (
    !principal.sessionId ||
    !principal.authTime ||
    !Number.isFinite(principal.authTime) ||
    principal.authTime * 1000 > now ||
    expiresAt <= now ||
    principal.authenticationMethod !== 'webauthn-passwordless'
  )
    return { verified: false, expiresAt: null };
  const sessions = await client.listSessions(principal.subject);
  return expiresAt > Date.now() && sessions.some((session) => session.id === principal.sessionId)
    ? { verified: true, expiresAt }
    : { verified: false, expiresAt: null };
}

export async function requireSupportAssurance(principal: Principal, client: IdentityAdminClient) {
  if (!(await supportAssurance(principal, client)).verified)
    throw new HttpError(
      403,
      'recent_authentication_required',
      'Verify your identity with a passkey before this action. Verification lasts five minutes.',
    );
}
