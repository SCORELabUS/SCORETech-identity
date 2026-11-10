import { z } from 'zod';
import { parseDocument, stringify } from 'yaml';
import { HttpError } from '../../shared/http/errors.js';

const Name = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/);
const Description = z.string().trim().max(500).default('');
const ProtectedCatalogueRole = 'administrador';
const PublicRegistrationRole = 'member';
const ProtectedClientIds = new Set([
  'account',
  'account-console',
  'admin-cli',
  'broker',
  'realm-management',
  'security-admin-console',
]);
const ReservedPermissionDomains = new Set([
  'identity',
  'admin-web',
  'account',
  'account-console',
  'admin-cli',
  'broker',
  'keycloak',
  'realm-admin',
  'realm-management',
  'security-admin-console',
  'system',
]);
const ApplicationOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const origin = new URL(value);
      return (
        value === origin.origin &&
        !value.includes('*') &&
        !origin.hostname.endsWith('.') &&
        !origin.username &&
        !origin.password &&
        origin.pathname === '/' &&
        !origin.search &&
        !origin.hash &&
        (origin.protocol === 'https:' ||
          (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))
      );
    } catch {
      return false;
    }
  }, 'Use a canonical HTTPS origin, or an exact localhost/127.0.0.1 HTTP origin for local development.');
export const AccessRuleSchema = z
  .object({
    id: Name,
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
      .refine(
        (name) =>
          !name.toLowerCase().startsWith('identity-') &&
          !name.toLowerCase().startsWith('score-app-') &&
          !ProtectedClientIds.has(name.toLowerCase()),
        'Identity, internal Keycloak and Applications-managed clients cannot be managed by advanced access rules.',
      ),
    origin: ApplicationOrigin,
    requiredPermissions: z.array(Name).min(1).max(1000),
  })
  .strict();
export type AccessRule = z.infer<typeof AccessRuleSchema>;
const AccessRules = z.array(AccessRuleSchema).max(250);
export const CatalogueSchema = z
  .object({
    defaultRole: Name.optional(),
    permissions: z
      .array(
        z
          .object({
            name: Name.refine((name) => name.includes(':'), 'A permission must include a domain.'),
            description: Description,
          })
          .strict(),
      )
      .max(2000),
    roles: z
      .array(
        z
          .object({ name: Name, description: Description, permissions: z.array(Name).max(2000) })
          .strict(),
      )
      .min(1)
      .max(250),
    groups: z.array(z.object({ name: Name, roles: z.array(Name).max(250) }).strict()).max(250),
    accessRules: AccessRules.optional(),
  })
  .strict();
export type Catalogue = z.infer<typeof CatalogueSchema>;
const SourceSchema = z.object({
  authorizationRegistry: z.object({ accessRules: AccessRules.optional() }).passthrough().optional(),
  permissions: z
    .record(
      z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()),
    )
    .default({}),
  realm: z.object({
    name: z.string(),
    displayName: z.string().optional(),
    settings: z
      .object({ defaultRole: z.object({ name: Name }).passthrough().optional() })
      .passthrough()
      .optional(),
    roles: z.object({
      realm: z.array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            composite: z.boolean().optional(),
            composites: z
              .object({
                realm: z.array(z.string()).optional(),
                client: z.record(z.array(z.string())).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ),
    }),
    groups: z
      .array(
        z.object({ name: z.string(), realmRoles: z.array(z.string()).default([]) }).passthrough(),
      )
      .default([]),
  }),
});
export function parseYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    throw new HttpError(422, 'invalid_yaml', 'The catalogue contains invalid YAML.');
  return document.toJS({ maxAliasCount: 20 }) as unknown;
}
export function readCatalogue(text: string | Record<string, unknown>): Catalogue {
  const source = SourceSchema.parse(typeof text === 'string' ? parseYaml(text) : text);
  return CatalogueSchema.parse({
    defaultRole: source.realm.settings?.defaultRole?.name,
    accessRules: source.authorizationRegistry?.accessRules ?? [],
    permissions: Object.entries(source.permissions).flatMap(([domain, permissions]) =>
      permissions.map((permission) => ({
        name: `${domain}:${permission.name}`,
        description: permission.description ?? '',
      })),
    ),
    roles: source.realm.roles.realm.map((role) => ({
      name: role.name.trim(),
      description: role.description ?? '',
      permissions: role.composites?.realm?.map((name) => name.trim()) ?? [],
    })),
    groups: source.realm.groups.map((group) => ({
      name: group.name,
      roles: group.realmRoles.map((name) => name.trim()),
    })),
  });
}
export function isProtectedPermission(name: string): boolean {
  const domain = name.split(':')[0]!;
  return (
    ReservedPermissionDomains.has(domain) ||
    domain.startsWith('identity-') ||
    domain.startsWith('default-roles-')
  );
}

export function validateCatalogue(input: unknown, _previous?: Catalogue): Catalogue {
  const catalogue = CatalogueSchema.parse(input);
  catalogue.accessRules ??= structuredClone(_previous?.accessRules ?? []);
  if (_previous) {
    const nextPermissions = new Map(
      catalogue.permissions.map((permission) => [permission.name, permission]),
    );
    if (
      _previous.permissions.some((permission) =>
        nextPermissions.has(permission.name)
          ? nextPermissions.get(permission.name)!.description !== permission.description
          : isProtectedPermission(permission.name),
      )
    )
      throw new HttpError(
        422,
        'managed_permissions',
        'Internal permissions cannot be removed; existing descriptions cannot be changed.',
      );
    const previousNames = new Set(_previous.permissions.map((permission) => permission.name));
    if (
      catalogue.permissions.some(({ name }) => {
        const domain = name.split(':')[0]!;
        return (
          !previousNames.has(name) &&
          (ReservedPermissionDomains.has(domain) ||
            domain.startsWith('identity-') ||
            domain.startsWith('default-roles-'))
        );
      })
    )
      throw new HttpError(
        422,
        'reserved_permission',
        'New permissions must belong to an application namespace, outside protected identity and system namespaces.',
      );
    const administrator = (value: Catalogue) =>
      value.roles.find((role) => role.name === ProtectedCatalogueRole);
    const previousAdministrator = administrator(_previous);
    const nextAdministrator = administrator(catalogue);
    const sameReferences = (left: string[], right: string[]) =>
      JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    const derivedPermissions = catalogue.permissions.map((permission) => permission.name);
    if (
      !previousAdministrator ||
      !nextAdministrator ||
      nextAdministrator.description !== previousAdministrator.description ||
      (!sameReferences(nextAdministrator.permissions, previousAdministrator.permissions) &&
        !sameReferences(nextAdministrator.permissions, derivedPermissions))
    )
      throw new HttpError(422, 'protected_role', 'The administrator role definition is protected.');
    nextAdministrator.permissions = derivedPermissions;
  }
  const names = [...catalogue.permissions, ...catalogue.roles].map((item) => item.name);
  if (new Set(names).size !== names.length)
    throw new HttpError(422, 'duplicate_name', 'Roles and permissions must have unique names.');
  if (new Set(catalogue.groups.map((group) => group.name)).size !== catalogue.groups.length)
    throw new HttpError(422, 'duplicate_group', 'Groups must have unique names.');
  validateAccessRules(
    catalogue.accessRules,
    new Set(catalogue.permissions.map((permission) => permission.name)),
  );
  if (
    names.some(
      (name) =>
        ['offline_access', 'uma_authorization', 'realm-admin'].includes(name) ||
        name.startsWith('default-roles-'),
    )
  )
    throw new HttpError(422, 'system_role', 'Internal Keycloak roles cannot be managed here.');
  const roles = new Map(catalogue.roles.map((role) => [role.name, role]));
  catalogue.defaultRole = registrationDefaultRole(
    catalogue,
    catalogue.defaultRole ?? _previous?.defaultRole,
  );
  if (!roles.has(ProtectedCatalogueRole))
    throw new HttpError(
      422,
      'protected_role',
      'The protected administrator role must be retained.',
    );
  for (const role of catalogue.roles) {
    if (new Set(role.permissions).size !== role.permissions.length)
      throw new HttpError(422, 'duplicate_reference', `Duplicate references in ${role.name}.`);
    if (role.permissions.includes(ProtectedCatalogueRole))
      throw new HttpError(
        422,
        'protected_reference',
        'A role cannot inherit the protected administrator role.',
      );
    for (const name of role.permissions)
      if (!names.includes(name))
        throw new HttpError(
          422,
          'missing_reference',
          `${role.name} references ${name}, which does not exist.`,
        );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name))
      throw new HttpError(422, 'role_cycle', `Role composition contains a cycle at ${name}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of roles.get(name)?.permissions ?? []) if (roles.has(child)) visit(child);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of roles.keys()) visit(name);
  assertUnprivilegedDefaultRole(catalogue, PublicRegistrationRole);
  const administratorPermissions = new Set<string>();
  const collectAdministratorPermissions = (name: string) => {
    for (const permission of roles.get(name)?.permissions ?? []) {
      if (roles.has(permission)) collectAdministratorPermissions(permission);
      else administratorPermissions.add(permission);
    }
  };
  collectAdministratorPermissions(ProtectedCatalogueRole);
  if (catalogue.permissions.some(({ name }) => !administratorPermissions.has(name)))
    throw new HttpError(
      422,
      'protected_composition',
      'The administrator role must retain all permissions.',
    );
  for (const group of catalogue.groups)
    for (const name of group.roles)
      if (!roles.has(name))
        throw new HttpError(
          422,
          'group_reference',
          `Group ${group.name} still references ${name}.`,
        );
  return catalogue;
}

function validateAccessRules(rules: AccessRule[], permissions: ReadonlySet<string>): void {
  if (
    new Set(rules.map((rule) => rule.id)).size !== rules.length ||
    new Set(rules.map((rule) => rule.clientId)).size !== rules.length
  )
    throw new HttpError(
      422,
      'duplicate_access_rule',
      'Application access rule IDs and client IDs must be unique.',
    );
  for (const rule of rules) {
    if (new Set(rule.requiredPermissions).size !== rule.requiredPermissions.length)
      throw new HttpError(
        422,
        'duplicate_reference',
        `Duplicate required permissions in ${rule.id}.`,
      );
    if (rule.requiredPermissions.some((permission) => !permissions.has(permission)))
      throw new HttpError(
        422,
        'access_rule_permission',
        'Application access rules must require known atomic permissions.',
      );
  }
}

function registrationDefaultRole(catalogue: Catalogue, selected: string | undefined): string {
  if (selected === ProtectedCatalogueRole)
    throw new HttpError(
      422,
      'protected_default_role',
      'The administrator role cannot be the registration default.',
    );
  if (selected && selected !== PublicRegistrationRole)
    throw new HttpError(
      422,
      'immutable_default_role',
      'The registration default role must remain member.',
    );
  if (!catalogue.roles.some((role) => role.name === PublicRegistrationRole))
    throw new HttpError(
      422,
      'missing_default_role',
      'The member registration default role must be retained.',
    );
  return PublicRegistrationRole;
}

function assertUnprivilegedDefaultRole(
  catalogue: Catalogue,
  defaultRole: string | undefined,
  hasClientPermissions: (name: string) => boolean = () => false,
): void {
  if (!defaultRole) return;
  const roles = new Map(catalogue.roles.map((role) => [role.name, role]));
  const pending = [defaultRole];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const role = roles.get(name);
    if (hasClientPermissions(name) || (!role && name.includes(':')))
      throw new HttpError(
        422,
        'privileged_default_role',
        'The registration default role cannot grant service access or privileged permissions.',
      );
    if (role) pending.push(...role.permissions);
  }
}

export function writeCatalogue(catalogue: Catalogue, sourceText: string): string {
  // Editing a node can remove an anchor referenced elsewhere in the snapshot.
  // Materialize aliases first so unrelated registry data cannot become dangling.
  const document = parseDocument(
    stringify(parseYaml(sourceText), { aliasDuplicateObjects: false }),
    { uniqueKeys: true },
  );
  const source = SourceSchema.parse(parseYaml(sourceText));
  const accessRules = AccessRules.parse(
    catalogue.accessRules ?? source.authorizationRegistry?.accessRules ?? [],
  );
  validateAccessRules(
    accessRules,
    new Set(catalogue.permissions.map((permission) => permission.name)),
  );
  const permissions: Record<string, { name: string; description: string }[]> = {};
  for (const permission of [...catalogue.permissions].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const index = permission.name.indexOf(':');
    const domain = permission.name.slice(0, index);
    (permissions[domain] ??= []).push({
      ...source.permissions[domain]?.find((item) => item.name === permission.name.slice(index + 1)),
      name: permission.name.slice(index + 1),
      description: permission.description,
    });
  }
  const defaultRole = registrationDefaultRole(
    catalogue,
    catalogue.defaultRole ?? source.realm.settings?.defaultRole?.name,
  );
  assertUnprivilegedDefaultRole(catalogue, defaultRole, (name) =>
    Object.values(
      source.realm.roles.realm.find((role) => role.name.trim() === name)?.composites?.client ?? {},
    ).some((entries) => entries.length > 0),
  );
  if (defaultRole) {
    const selected = catalogue.roles.find((role) => role.name === defaultRole);
    const previous = source.realm.roles.realm.find((role) => role.name === defaultRole);
    document.setIn(['realm', 'settings', 'defaultRole'], {
      name: defaultRole,
      composite:
        Boolean(selected?.permissions.length) ||
        Object.values(previous?.composites?.client ?? {}).some((entries) => entries.length > 0),
    });
  }
  document.set('permissions', permissions);
  document.setIn(['authorizationRegistry', 'accessRules'], accessRules);
  document.setIn(
    ['realm', 'roles', 'realm'],
    catalogue.roles.map((role) => {
      const previous = source.realm.roles.realm.find((item) => item.name.trim() === role.name);
      const rendered: Record<string, unknown> = {
        ...previous,
        name: role.name,
        description: role.description,
        composite:
          role.permissions.length > 0 ||
          Object.values(previous?.composites?.client ?? {}).some((entries) => entries.length > 0),
        composites: { ...previous?.composites, realm: role.permissions },
      };
      const oldGrants = previous?.composites?.realm?.map((name) => name.trim()).sort() ?? [];
      if (JSON.stringify(oldGrants) !== JSON.stringify([...role.permissions].sort()))
        delete rendered.inactivePermissions;
      return rendered;
    }),
  );
  document.setIn(
    ['realm', 'groups'],
    catalogue.groups.map((group) => ({
      ...source.realm.groups.find((item) => item.name === group.name),
      name: group.name,
      realmRoles: group.roles,
    })),
  );
  return document.toString({ lineWidth: 100 });
}
// GitOps also reads these files with Ruby/Psych (YAML 1.1). Quote date-like
// strings instead of turning legal release versions into timestamp objects.
export const dumpYaml = (value: unknown): string =>
  stringify(value, { lineWidth: 100, compat: 'yaml-1.1', aliasDuplicateObjects: false });
