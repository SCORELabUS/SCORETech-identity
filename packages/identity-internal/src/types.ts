export interface IdentityUser {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
  attributes?: Record<string, string[]>;
}

export interface IdentityRole {
  id: string;
  name: string;
  description?: string;
  composite?: boolean;
}

export interface CreateIdentityUser {
  attributes?: Record<string, string[]>;
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
}

export interface UpdateIdentityUser {
  email?: string;
  emailVerified?: boolean;
  attributes?: Record<string, string[]>;
  attributeDefaults?: Record<string, string[]>;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
}

export interface UserFilters {
  role?: string;
  enabled?: boolean;
  emailVerified?: boolean;
}

export interface UserSummary {
  total: number;
  enabled: number;
  emailUnverified: number;
}

export interface IdentityCredential {
  id: string;
  type: string;
  userLabel?: string;
  createdDate?: number;
}

export interface RecoveryLink {
  id: string;
  caseReference: string;
  url: string;
  expiresAt: number;
  state: string;
}
export interface RecoveryRequest {
  draftId?: string;
  reason: string;
  identityVerified: true;
}
export interface IdentityAdminClient {
  prepareRecovery?(
    userId: string,
    accessToken: string,
  ): Promise<{ id: string; caseReference: string; expiresAt: number }>;
  recoveryStatus?(
    userId: string,
    accessToken: string,
  ): Promise<{
    recovery: { id: string; state: string; expiresAt: number; caseReference: string } | null;
  }>;
  createRecovery?(
    userId: string,
    accessToken: string,
    body: RecoveryRequest,
  ): Promise<RecoveryLink>;
  revokeRecovery?(userId: string, recoveryId: string, accessToken: string): Promise<void>;
  listSecurityEvents?(filters: SecurityEventFilters): Promise<SecurityEventsPage>;
  listCredentials?(userId: string): Promise<IdentityCredential[]>;
  deleteCredential?(
    userId: string,
    credentialId: string,
    accessToken: string,
    reason: string,
  ): Promise<void>;
  reserveVerification?(userId: string, accessToken: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  setPassword(userId: string, password: string): Promise<void>;
  listSessions(userId: string): Promise<IdentitySession[]>;
  listUsers(
    search: string | undefined,
    first: number,
    max: number,
    filters?: UserFilters,
  ): Promise<IdentityUser[]>;
  /** Effective membership in promoted, managed realm roles; enabled users only. */
  listEffectiveRoleUsers?(roles: readonly string[]): Promise<IdentityUser[]>;
  summarizeUsers?(search: string | undefined, filters?: UserFilters): Promise<UserSummary>;
  getUser(userId: string): Promise<IdentityUser>;
  createUser(user: CreateIdentityUser): Promise<string>;
  updateUser(userId: string, user: UpdateIdentityUser): Promise<void>;
  executeActionsEmail(
    userId: string,
    actions: string[],
    options?: { lifespan: number; clientId?: string; redirectUri?: string },
  ): Promise<void>;
  logoutUser(userId: string): Promise<void>;
  logoutSession(userId: string, sessionId: string): Promise<void>;
  listRealmRoles(): Promise<IdentityRole[]>;
  getUserRealmRoles(userId: string): Promise<IdentityRole[]>;
  getUserRealmEffectiveRoles?(userId: string): Promise<IdentityRole[]>;
  replaceManagedRealmRoles(userId: string, roles: string[]): Promise<void>;
}

export interface IdentitySession {
  id: string;
  ipAddress?: string;
  start: number;
  lastAccess: number;
  clients?: Record<string, string>;
}

export interface SecurityEventFilters {
  search?: string;
  user?: string;
  client?: string;
  type?: string;
  dateFrom?: string;
  dateTo?: string;
  first?: number;
  max?: number;
}
export interface SecurityEvent {
  time: number;
  type: string;
  userId?: string;
  sessionId?: string;
  clientId?: string;
  ipAddress?: string;
  error?: string;
  browser?: string;
  operatingSystem?: string;
  device?: string;
}
export interface SecurityEventsPage {
  events: SecurityEvent[];
  enabled: boolean;
  first: number;
  max: number;
}
