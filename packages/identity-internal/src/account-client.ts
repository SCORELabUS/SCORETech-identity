import { KeycloakAdminClient } from './keycloak-client.js';
import type { IdentityAdminClient, IdentityUser, UpdateIdentityUser } from './types.js';
export type IdentityAccountClient = Pick<
  IdentityAdminClient,
  | 'listCredentials'
  | 'getUser'
  | 'getUserRealmRoles'
  | 'getUserRealmEffectiveRoles'
  | 'listSessions'
  | 'listSecurityEvents'
  | 'logoutSession'
  | 'logoutUser'
  | 'executeActionsEmail'
> & {
  findUsersByEmail(email: string): Promise<Pick<IdentityUser, 'id' | 'email'>[]>;
  updateUser(
    userId: string,
    user: Pick<UpdateIdentityUser, 'firstName' | 'lastName' | 'attributes'>,
  ): Promise<void>;
};
export const createAccountClient = (
  options: ConstructorParameters<typeof KeycloakAdminClient>[0],
): IdentityAccountClient => {
  const client = new KeycloakAdminClient(options);
  return {
    listCredentials: client.listCredentials.bind(client),
    getUser: client.getUser.bind(client),
    findUsersByEmail: async (email) =>
      (await client.findUsersByEmail(email)).map(({ id, email: userEmail }) => ({
        id,
        email: userEmail,
      })),
    updateUser: client.updateUser.bind(client),
    getUserRealmRoles: client.getUserRealmRoles.bind(client),
    getUserRealmEffectiveRoles: client.getUserRealmEffectiveRoles.bind(client),
    listSessions: client.listSessions.bind(client),
    listSecurityEvents: client.listSecurityEvents.bind(client),
    logoutSession: client.logoutSession.bind(client),
    logoutUser: client.logoutUser.bind(client),
    executeActionsEmail: client.executeActionsEmail.bind(client),
  };
};
