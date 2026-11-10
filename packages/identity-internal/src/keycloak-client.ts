import type { RecoveryRequest } from './types.js';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { describeDevice } from './device.js';
import type { SecurityEventFilters, SecurityEventsPage } from './types.js';
import type {
  CreateIdentityUser,
  IdentityAdminClient,
  IdentityRole,
  IdentityUser,
  IdentitySession,
  UserSummary,
  UpdateIdentityUser,
  UserFilters,
} from './types.js';

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface KeycloakAdminClientOptions {
  issuer: string;
  /** Optional private realm URL for server-to-server requests. */
  transportUrl?: string;
  adminUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  fetchImplementation?: typeof fetch;
  managedRoles?: string[];
  roleCatalogue?: () => Promise<string[]>;
}

const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  composite: z.boolean().optional(),
});
const UserSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  email: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  enabled: z.boolean(),
  emailVerified: z.boolean(),
  createdTimestamp: z.number().optional(),
  attributes: z.record(z.array(z.string())).optional(),
});
const SessionSchema = z.object({
  id: z.string(),
  ipAddress: z.string().optional(),
  start: z.number(),
  lastAccess: z.number(),
  clients: z.record(z.string()).optional(),
});

export class KeycloakAdminClient implements IdentityAdminClient {
  public async listSecurityEvents(filters: SecurityEventFilters): Promise<SecurityEventsPage> {
    const first = filters.first ?? 0;
    const max = filters.max ?? 50;
    const query = new URLSearchParams({ first: String(first), max: String(max) });
    for (const key of ['user', 'client', 'type', 'dateFrom', 'dateTo'] as const) {
      if (filters[key]) query.set(key, filters[key]);
    }
    const config = z
      .object({ eventsEnabled: z.boolean().optional() })
      .parse(await this.request<unknown>('/events/config'));
    if (!config.eventsEnabled) return { events: [], enabled: false, first, max };
    const schema = z.array(
      z.object({
        time: z.number(),
        type: z.string(),
        userId: z.string().optional(),
        sessionId: z.string().optional(),
        clientId: z.string().optional(),
        ipAddress: z.string().optional(),
        error: z.string().optional(),
        details: z.record(z.string()).optional(),
      }),
    );
    const project = (raw: z.infer<typeof schema>) =>
      raw.map(({ details, ...event }) => ({ ...event, ...describeDevice(details?.user_agent) }));
    const search = filters.search?.trim().toLowerCase();
    if (!search) {
      const raw = schema.parse(await this.request<unknown>(`/events?${query.toString()}`));
      return { enabled: true, first, max, events: project(raw) };
    }
    // Filter safe event fields before counting matches, across provider pages.
    // Never silently truncate a search or search arbitrary sensitive details.
    const events: SecurityEventsPage['events'] = [];
    let matched = 0;
    const signal = AbortSignal.timeout(10000);
    try {
      for (let offset = 0; offset < 100000; offset += 100) {
        query.set('first', String(offset));
        query.set('max', '100');
        const raw = schema.parse(
          await this.request<unknown>(`/events?${query.toString()}`, signal),
        );
        for (const event of project(raw)) {
          const text = [
            event.type,
            event.type.replaceAll('_', ' '),
            event.clientId,
            event.userId,
            event.ipAddress,
            event.error,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (text.includes(search) && matched++ >= first) events.push(event);
          if (events.length === max) return { enabled: true, first, max, events };
        }
        if (raw.length < 100) return { enabled: true, first, max, events };
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    throw new HttpError(
      503,
      'events_search_limit',
      'This event search is too broad. Select an event type or use a more specific search. No partial page was returned.',
    );
  }

  private readonly managedRoleNames: Set<string>;
  private readonly baseUrl: string;
  private readonly realmUrl: string;
  private readonly tokenEndpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private accessToken?: { value: string; expiresAt: number };
  private directoryGeneration = 0;
  private directorySnapshots = new Map<
    string,
    { expiresAt: number; promise: Promise<IdentityUser[]> }
  >();
  private invalidateDirectory() {
    this.directoryGeneration++;
    this.directorySnapshots.clear();
  }

  public constructor(private readonly options: KeycloakAdminClientOptions) {
    this.managedRoleNames = new Set(options.managedRoles ?? ['admin', 'user']);
    this.baseUrl = `${options.adminUrl.replace(/\/$/, '')}/admin/realms/${encodeURIComponent(options.realm)}`;
    this.realmUrl = (options.transportUrl ?? options.issuer).replace(/\/$/, '');
    this.tokenEndpoint = `${this.realmUrl}/protocol/openid-connect/token`;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async listUsers(
    search: string | undefined,
    first: number,
    max: number,
    filters: UserFilters = {},
  ): Promise<IdentityUser[]> {
    if (filters.role) return this.listRoleUsers(filters.role, search, first, max, filters);
    if (search?.trim()) {
      const selected: IdentityUser[] = [];
      for await (const page of this.matchingUserPages(search, filters)) {
        selected.push(...page);
        if (selected.length >= first + max) break;
      }
      return selected.slice(first, first + max);
    }
    const query = new URLSearchParams({
      first: String(first),
      max: String(max),
      briefRepresentation: 'true',
    });
    if (search) query.set('search', search);
    if (filters.enabled !== undefined) query.set('enabled', String(filters.enabled));
    if (filters.emailVerified !== undefined)
      query.set('emailVerified', String(filters.emailVerified));
    return UserSchema.array().parse(await this.request<unknown>(`/users?${query.toString()}`));
  }

  /**
   * Resolve promoted realm-role membership without listing the realm user directory.
   * Only catalogue-managed realm-role composites participate; client-role parents
   * are outside this catalogue contract. Group descendants inherit parent roles.
   */
  public async listEffectiveRoleUsers(roles: readonly string[]): Promise<IdentityUser[]> {
    const requested = new Set(roles);
    if (requested.size === 0) return [];
    const managed = await this.managedNames();
    if ([...requested].some((role) => !managed.has(role)))
      throw new HttpError(400, 'invalid_role', 'The role is not in the applied catalogue.');
    const overflow = () =>
      new HttpError(
        502,
        'directory_limit',
        'The directory exceeds the query limit. No partial listing was returned.',
      );
    let requests = 0;
    const read = async (endpoint: string): Promise<unknown> => {
      if (++requests > 10000) throw overflow();
      return this.request<unknown>(endpoint);
    };
    const pageAll = async <T extends { id: string }>(
      endpoint: string,
      parse: (value: unknown) => T[],
      limit: number,
    ): Promise<T[]> => {
      const result = new Map<string, T>();
      for (let first = 0; first <= limit; first += 100) {
        const separator = endpoint.includes('?') ? '&' : '?';
        const page = parse(await read(`${endpoint}${separator}first=${first}&max=100`));
        const before = result.size;
        for (const item of page) result.set(item.id, item);
        if (result.size > limit) throw overflow();
        if (page.length < 100) return [...result.values()];
        if (result.size === before) throw overflow();
      }
      throw overflow();
    };
    const allRoles = await pageAll(
      '/roles?briefRepresentation=true',
      (value) => RoleSchema.array().parse(value),
      10000,
    );
    const catalogueRoles = allRoles.filter((role) => managed.has(role.name));
    if (catalogueRoles.length > 1000) throw overflow();
    const byId = new Map(catalogueRoles.map((role) => [role.id, role]));
    const byName = new Map(catalogueRoles.map((role) => [role.name, role]));
    if ([...requested].some((role) => !byName.has(role)))
      throw new HttpError(400, 'invalid_role', 'The role no longer exists.');
    const parents = new Map<string, Set<string>>();
    for (const role of catalogueRoles.filter((role) => role.composite)) {
      const children = await pageAll(
        `/roles-by-id/${encodeURIComponent(role.id)}/composites`,
        (value) => RoleSchema.array().parse(value),
        10000,
      );
      for (const child of children) {
        if (!byId.has(child.id)) continue;
        const ancestorIds = parents.get(child.id) ?? new Set<string>();
        ancestorIds.add(role.id);
        parents.set(child.id, ancestorIds);
      }
    }
    const relevantIds = new Set<string>();
    const pendingIds = [...requested].map((name) => byName.get(name)!.id);
    for (let index = 0; index < pendingIds.length; index++) {
      const id = pendingIds[index]!;
      if (relevantIds.has(id)) continue;
      relevantIds.add(id);
      for (const parent of parents.get(id) ?? [])
        if (!relevantIds.has(parent)) pendingIds.push(parent);
      if (pendingIds.length > 10000) throw overflow();
    }
    const groupSchema = z.array(z.object({ id: z.string() }));
    const groupIds = new Set<string>();
    const candidates = new Map<string, IdentityUser>();
    const collectUsers = (users: IdentityUser[]) => {
      for (const user of users) if (user.enabled) candidates.set(user.id, user);
      if (candidates.size > 5000) throw overflow();
    };
    for (const id of relevantIds) {
      const role = byId.get(id)!;
      const endpoint = `/roles/${encodeURIComponent(role.name)}`;
      collectUsers(
        await pageAll(`${endpoint}/users`, (value) => UserSchema.array().parse(value), 10000),
      );
      for (const group of await pageAll(
        `${endpoint}/groups`,
        (value) => groupSchema.parse(value),
        1000,
      ))
        groupIds.add(group.id);
    }
    const pendingGroups = [...groupIds];
    for (let index = 0; index < pendingGroups.length; index++) {
      if (groupIds.size > 1000) throw overflow();
      const endpoint = `/groups/${encodeURIComponent(pendingGroups[index]!)}`;
      collectUsers(
        await pageAll(`${endpoint}/members`, (value) => UserSchema.array().parse(value), 10000),
      );
      for (const child of await pageAll(
        `${endpoint}/children?briefRepresentation=true&subGroupsCount=false`,
        (value) => groupSchema.parse(value),
        1000,
      )) {
        if (groupIds.has(child.id)) continue;
        groupIds.add(child.id);
        pendingGroups.push(child.id);
      }
    }
    // /realm/composite uses UserModel.hasRole, which includes group inheritance.
    // Revalidate candidates to avoid retaining memberships removed during discovery.
    const users = [...candidates.values()];
    const result: IdentityUser[] = [];
    for (let index = 0; index < users.length; index += 4) {
      const batch = await Promise.all(
        users.slice(index, index + 4).map(async (user) => {
          const effective = RoleSchema.array().parse(
            await read(`/users/${encodeURIComponent(user.id)}/role-mappings/realm/composite`),
          );
          return effective.some((role) => requested.has(role.name)) ? user : null;
        }),
      );
      for (const user of batch) if (user) result.push(user);
    }
    return result;
  }

  public async findUsersByEmail(email: string): Promise<IdentityUser[]> {
    const query = new URLSearchParams({
      email: email.trim(),
      exact: 'true',
      first: '0',
      max: '100',
      briefRepresentation: 'true',
    });
    return UserSchema.array().parse(await this.request<unknown>(`/users?${query.toString()}`));
  }

  public async summarizeUsers(
    search: string | undefined,
    filters: UserFilters = {},
  ): Promise<UserSummary> {
    if (filters.role) return this.summarizeRoleUsers(filters.role, search, filters);
    if (search) return this.summarizeListedUsers(search, filters);

    const count = async (enabled?: boolean, emailVerified?: boolean) => {
      const query = new URLSearchParams();
      if (search) query.set('search', search);
      if (enabled !== undefined) query.set('enabled', String(enabled));
      if (emailVerified !== undefined) query.set('emailVerified', String(emailVerified));
      const queryString = query.toString();
      return z
        .number()
        .int()
        .nonnegative()
        .parse(await this.request<unknown>(`/users/count${queryString ? `?${queryString}` : ''}`));
    };
    const [total, enabled, emailUnverified] = await Promise.all([
      count(filters.enabled, filters.emailVerified),
      filters.enabled === false ? 0 : count(true, filters.emailVerified),
      filters.emailVerified === true ? 0 : count(filters.enabled, false),
    ]);
    return { total, enabled, emailUnverified };
  }

  /** Keycloak's native name search is accent-sensitive: filter before pagination. */
  private async *matchingUserPages(
    search: string,
    filters: UserFilters,
  ): AsyncGenerator<IdentityUser[]> {
    const fold = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const terms = fold(search).split(/\s+/).filter(Boolean);
    const users = await this.directorySnapshot(filters);
    yield users.filter((user) =>
      terms.every((term) =>
        fold(
          [user.username, user.email, user.firstName, user.lastName].filter(Boolean).join(' '),
        ).includes(term),
      ),
    );
  }

  private async directorySnapshot(filters: UserFilters): Promise<IdentityUser[]> {
    const key = JSON.stringify([filters.enabled ?? null, filters.emailVerified ?? null]);
    const cached = this.directorySnapshots.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    if (this.directorySnapshots.size >= 4)
      this.directorySnapshots.delete(this.directorySnapshots.keys().next().value!);
    const generation = this.directoryGeneration;
    const entry = { expiresAt: Infinity, promise: this.readDirectory(filters) };
    this.directorySnapshots.set(key, entry);
    try {
      const users = await entry.promise;
      if (this.directoryGeneration === generation && this.directorySnapshots.get(key) === entry)
        entry.expiresAt = Date.now() + 5000;
      return users;
    } catch (error) {
      if (this.directorySnapshots.get(key) === entry) this.directorySnapshots.delete(key);
      throw error;
    }
  }

  private async readDirectory(filters: UserFilters): Promise<IdentityUser[]> {
    const signal = AbortSignal.timeout(15000);
    const seen = new Set<string>();
    const users: IdentityUser[] = [];
    try {
      for (let first = 0; first < 100000; first += 100) {
        if (signal.aborted) throw signal.reason;
        const query = new URLSearchParams({
          first: String(first),
          max: '100',
          briefRepresentation: 'true',
        });
        if (filters.enabled !== undefined) query.set('enabled', String(filters.enabled));
        if (filters.emailVerified !== undefined)
          query.set('emailVerified', String(filters.emailVerified));
        const page = UserSchema.array().parse(
          await this.request<unknown>(`/users?${query.toString()}`, signal),
        );
        const before = seen.size;
        for (const user of page) {
          if (seen.has(user.id)) continue;
          seen.add(user.id);
          if (
            (filters.enabled === undefined || user.enabled === filters.enabled) &&
            (filters.emailVerified === undefined || user.emailVerified === filters.emailVerified)
          )
            users.push(user);
        }
        if (page.length < 100) return users;
        if (seen.size === before)
          throw new HttpError(
            502,
            'user_search_pagination_stalled',
            'Unable to complete the directory search. Try again.',
          );
      }
      throw new HttpError(
        422,
        'user_search_limit',
        'The directory exceeds the 100,000-user search limit. No partial listing was returned.',
      );
    } catch (error) {
      if (signal.aborted)
        throw new HttpError(
          504,
          'user_search_timeout',
          'The directory search timed out. Try again.',
        );
      throw error;
    }
  }

  private async summarizeListedUsers(search: string, filters: UserFilters): Promise<UserSummary> {
    const summary: UserSummary = { total: 0, enabled: 0, emailUnverified: 0 };
    for await (const page of this.matchingUserPages(search, filters)) {
      for (const user of page) {
        summary.total++;
        if (user.enabled) summary.enabled++;
        if (!user.emailVerified) summary.emailUnverified++;
      }
    }
    return summary;
  }

  private async summarizeRoleUsers(
    role: string,
    search: string | undefined,
    filters: UserFilters,
  ): Promise<UserSummary> {
    if (!(await this.managedNames()).has(role))
      throw new HttpError(400, 'invalid_role', 'The role is not in the applied catalogue.');
    const normalize = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const terms = normalize(search ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const summary: UserSummary = { total: 0, enabled: 0, emailUnverified: 0 };
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 100) {
      const page = UserSchema.array().parse(
        await this.request<unknown>(
          `/roles/${encodeURIComponent(role)}/users?first=${offset}&max=100`,
        ),
      );
      let added = 0;
      for (const user of page) {
        if (seen.has(user.id)) continue;
        seen.add(user.id);
        added++;
        if (
          (filters.enabled !== undefined && user.enabled !== filters.enabled) ||
          (filters.emailVerified !== undefined && user.emailVerified !== filters.emailVerified) ||
          !terms.every((term) =>
            normalize(
              [user.username, user.email, user.firstName, user.lastName].filter(Boolean).join(' '),
            ).includes(term),
          )
        )
          continue;
        summary.total++;
        if (user.enabled) summary.enabled++;
        if (!user.emailVerified) summary.emailUnverified++;
      }
      if (page.length < 100) return summary;
      if (added === 0)
        throw new HttpError(
          502,
          'user_summary_pagination_stalled',
          'Unable to count the directory. Try again.',
        );
    }
  }

  private async managedNames(): Promise<Set<string>> {
    return this.options.roleCatalogue
      ? new Set(await this.options.roleCatalogue())
      : this.managedRoleNames;
  }
  private async listRoleUsers(
    role: string,
    search: string | undefined,
    first: number,
    max: number,
    filters: UserFilters,
  ): Promise<IdentityUser[]> {
    if (!(await this.managedNames()).has(role))
      throw new HttpError(400, 'invalid_role', 'The role is not in the applied catalogue.');
    const selected: IdentityUser[] = [];
    const normalize = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const terms = normalize(search ?? '')
      .split(/\s+/)
      .filter(Boolean);
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = UserSchema.array().parse(
        await this.request<unknown>(
          `/roles/${encodeURIComponent(role)}/users?first=${offset}&max=100`,
        ),
      );
      selected.push(
        ...page.filter(
          (user) =>
            (filters.enabled === undefined || user.enabled === filters.enabled) &&
            (filters.emailVerified === undefined || user.emailVerified === filters.emailVerified) &&
            terms.every((term) =>
              normalize(
                [user.username, user.email, user.firstName, user.lastName]
                  .filter(Boolean)
                  .join(' '),
              ).includes(term),
            ),
        ),
      );
      if (selected.length >= first + max || page.length < 100)
        return selected.slice(first, first + max);
    }
    throw new HttpError(
      422,
      'filter_limit',
      'This role filter exceeds 10,000 members. Search without a role filter for a larger directory.',
    );
  }

  public async getUser(userId: string): Promise<IdentityUser> {
    return UserSchema.parse(await this.request<unknown>(`/users/${encodeURIComponent(userId)}`));
  }

  public async createUser(user: CreateIdentityUser): Promise<string> {
    const response = await this.requestResponse('/users', {
      method: 'POST',
      body: JSON.stringify({
        ...user,
        enabled: user.enabled ?? true,
        emailVerified: false,
        requiredActions: ['VERIFY_EMAIL'],
      }),
      expectedStatuses: [201],
    });
    const location = response.headers.get('location');
    const id = location?.split('/').at(-1);
    if (!id)
      throw new HttpError(
        502,
        'identity_provider_error',
        'Keycloak did not return the created user ID.',
      );
    return id;
  }

  public async updateUser(userId: string, user: UpdateIdentityUser): Promise<void> {
    this.invalidateDirectory();
    try {
      const token = await this.getAccessToken();
      const response = await this.fetchImplementation(
        `${this.realmUrl}/tentu-user-mutations/users/${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        },
      );
      if (response.status === 204) return;
      const messages: Record<number, string> = {
        400: 'Invalid profile changes.',
        401: 'The identity credential is invalid.',
        403: 'This credential cannot change these fields.',
        404: 'The account no longer exists.',
        409: 'The account has changed or the email already exists. Try again.',
      };
      throw new HttpError(
        response.status in messages ? response.status : 502,
        'identity_update_failed',
        messages[response.status] ?? 'Unable to update the account.',
      );
    } finally {
      this.invalidateDirectory();
    }
  }

  public async executeActionsEmail(
    userId: string,
    actions: string[],
    options?: { lifespan: number; clientId?: string; redirectUri?: string },
  ): Promise<void> {
    const query = new URLSearchParams();
    if (options) {
      query.set('lifespan', String(options.lifespan));
      if (options.clientId) query.set('client_id', options.clientId);
      if (options.redirectUri) query.set('redirect_uri', options.redirectUri);
    }
    await this.requestResponse(
      `/users/${encodeURIComponent(userId)}/execute-actions-email${options ? `?${query.toString()}` : ''}`,
      {
        method: 'PUT',
        body: JSON.stringify(actions),
        expectedStatuses: [204],
      },
    );
  }

  public async logoutUser(userId: string): Promise<void> {
    await this.requestResponse(`/users/${encodeURIComponent(userId)}/logout`, {
      method: 'POST',
      expectedStatuses: [204],
    });
  }

  public async logoutSession(userId: string, sessionId: string): Promise<void> {
    const sessions = await this.listSessions(userId);
    if (!sessions.some((session) => session.id === sessionId))
      throw new HttpError(404, 'not_found', 'The session is no longer active.');
    await this.requestResponse(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      expectedStatuses: [204],
    });
  }

  public listRealmRoles(): Promise<IdentityRole[]> {
    return this.managedNames().then(async (names) =>
      RoleSchema.array()
        .parse(await this.request<unknown>('/roles'))
        .filter((role) => names.has(role.name)),
    );
  }

  public getUserRealmRoles(userId: string): Promise<IdentityRole[]> {
    return this.request<unknown>(`/users/${encodeURIComponent(userId)}/role-mappings/realm`).then(
      (roles) => RoleSchema.array().parse(roles),
    );
  }

  public getUserRealmEffectiveRoles(userId: string): Promise<IdentityRole[]> {
    return this.request<unknown>(
      `/users/${encodeURIComponent(userId)}/role-mappings/realm/composite`,
    ).then((roles) => RoleSchema.array().parse(roles));
  }

  public async replaceManagedRealmRoles(userId: string, roles: string[]): Promise<void> {
    const requested = [...new Set(roles)];
    const managed = await this.managedNames();
    if (requested.some((role) => !managed.has(role))) {
      throw new HttpError(
        400,
        'invalid_role',
        'Only managed roles can be assigned through this endpoint.',
      );
    }
    const available = await this.listRealmRoles();
    const byName = new Map(available.map((role) => [role.name, role]));
    const target = requested
      .map((name) => byName.get(name))
      .filter((role): role is IdentityRole => Boolean(role));
    if (target.length !== requested.length) {
      throw new HttpError(400, 'unknown_role', 'One or more roles do not exist in Keycloak.');
    }
    const assigned = await this.getUserRealmRoles(userId);
    const remove = assigned.filter(
      (role) => managed.has(role.name) && !requested.includes(role.name),
    );
    const add = target.filter((role) => !assigned.some((current) => current.name === role.name));
    // Add first: a provider failure must not temporarily remove all existing access.
    for (const [method, changes] of [
      ['POST', add],
      ['DELETE', remove],
    ] as const) {
      if (changes.length)
        await this.requestResponse(`/users/${encodeURIComponent(userId)}/role-mappings/realm`, {
          method,
          body: JSON.stringify(changes),
          expectedStatuses: [204],
        });
    }
  }

  public async deleteUser(userId: string): Promise<void> {
    await this.requestResponse(`/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      expectedStatuses: [204],
    });
  }

  public async setPassword(userId: string, password: string): Promise<void> {
    await this.requestResponse(`/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'password', value: password, temporary: true }),
      expectedStatuses: [204],
    });
  }

  public async recoveryStatus(userId: string, accessToken: string) {
    const response = await this.recoveryRequest(
      `users/${encodeURIComponent(userId)}`,
      accessToken,
      { method: 'GET' },
    );
    return z
      .object({
        recovery: z
          .object({
            id: z.string().uuid(),
            state: z.string(),
            expiresAt: z.number(),
            caseReference: z.string(),
          })
          .nullable(),
      })
      .parse(await response.json());
  }
  public async prepareRecovery(userId: string, accessToken: string) {
    const response = await this.recoveryRequest(
      `users/${encodeURIComponent(userId)}/prepare`,
      accessToken,
      { method: 'POST' },
    );
    return z
      .object({ id: z.string().uuid(), caseReference: z.string().min(1), expiresAt: z.number() })
      .parse(await response.json());
  }
  public async createRecovery(userId: string, accessToken: string, body: RecoveryRequest) {
    const response = await this.recoveryRequest(
      `users/${encodeURIComponent(userId)}`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    return z
      .object({
        id: z.string().uuid(),
        caseReference: z.string().min(1),
        url: z.string().url(),
        expiresAt: z.number(),
        state: z.string(),
      })
      .parse(await response.json());
  }
  public async revokeRecovery(
    userId: string,
    recoveryId: string,
    accessToken: string,
  ): Promise<void> {
    await this.recoveryRequest(
      `users/${encodeURIComponent(userId)}/${encodeURIComponent(recoveryId)}`,
      accessToken,
      { method: 'DELETE' },
    );
  }
  private async recoveryRequest(
    path: string,
    accessToken: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: string },
  ): Promise<Response> {
    const response = await this.fetchImplementation(`${this.realmUrl}/tentu-recovery/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new HttpError(
        response.status >= 400 && response.status < 600 ? response.status : 502,
        'recovery_failed',
        {
          403: 'Check your passkey verification and permissions. The target account must be active, email-verified and without administrative access.',
          404: 'The account or recovery no longer exists.',
          409: 'Another change is in progress. Try again.',
          429: 'Wait 30 seconds before generating another link.',
          503: 'Unable to complete or notify account recovery.',
        }[response.status] ?? 'Unable to complete account recovery.',
      );
    return response;
  }
  public async deleteCredential(
    userId: string,
    credentialId: string,
    accessToken: string,
    reason: string,
  ): Promise<void> {
    await this.supportRequest(
      `users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
      accessToken,
      {
        method: 'DELETE',
        body: JSON.stringify({ reason, confirmed: true }),
      },
    );
  }
  public async reserveVerification(userId: string, accessToken: string): Promise<void> {
    await this.supportRequest(
      `users/${encodeURIComponent(userId)}/verification-request`,
      accessToken,
      { method: 'POST' },
    );
  }
  private async supportRequest(
    path: string,
    accessToken: string,
    init: { method: 'POST' | 'DELETE'; body?: string },
  ): Promise<void> {
    const response = await this.fetchImplementation(`${this.realmUrl}/tentu-support/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'Your session has expired.',
        403: 'Verify with a passkey within five minutes and check your permissions.',
        404: 'The account or sign-in method no longer exists.',
        409: 'Keep another usable method, an administrative passkey and a notification channel. Check whether another operation is in progress.',
        429: 'Espera cinco minutos antes de solicitar otro correo.',
        503: 'The account owner could not be notified. The sign-in method was not removed.',
      };
      throw new HttpError(
        response.status >= 400 && response.status < 600 ? response.status : 502,
        'support_operation_failed',
        messages[response.status] ?? 'Unable to complete the support operation.',
      );
    }
  }

  public async listCredentials(userId: string) {
    // Explicit projection excludes credentialData, secretData and WebAuthn public keys.
    return z
      .array(
        z.object({
          id: z.string(),
          type: z.string(),
          userLabel: z.string().optional(),
          createdDate: z.number().optional(),
        }),
      )
      .parse(await this.request<unknown>(`/users/${encodeURIComponent(userId)}/credentials`));
  }

  public async listSessions(userId: string): Promise<IdentitySession[]> {
    return SessionSchema.array().parse(
      await this.request<unknown>(`/users/${encodeURIComponent(userId)}/sessions`),
    );
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.requestResponse(path, { expectedStatuses: [200], signal });
    return (await response.json()) as T;
  }

  private async requestResponse(
    path: string,
    options: { method?: string; body?: string; expectedStatuses: number[]; signal?: AbortSignal },
  ): Promise<Response> {
    const mutating = !['GET', 'HEAD'].includes(options.method ?? 'GET');
    if (mutating) this.invalidateDirectory();
    try {
      const token = await this.getAccessToken();
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body,
      });
      if (options.expectedStatuses.includes(response.status)) return response;
      if (response.status === 409)
        throw new HttpError(409, 'identity_conflict', 'The account or email already exists.');
      if (response.status === 400)
        throw new HttpError(
          400,
          'identity_validation',
          'The identity provider rejected the data. Check the profile policy.',
        );
      if (response.status === 404)
        throw new HttpError(404, 'not_found', 'Identity resource not found.');
      throw new HttpError(
        502,
        'identity_provider_error',
        `Keycloak administration request failed (${response.status}).`,
      );
    } finally {
      if (mutating) this.invalidateDirectory();
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const response = await this.fetchImplementation(this.tokenEndpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok)
      throw new HttpError(
        502,
        'identity_provider_error',
        'Could not obtain the Keycloak service token.',
      );
    const token: AccessTokenResponse = z
      .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
      .parse(await response.json());
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(0, token.expires_in - 30) * 1000,
    };
    return token.access_token;
  }
}
