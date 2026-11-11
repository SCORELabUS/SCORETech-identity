import { describe, expect, it } from 'vitest';
import type { Principal } from '@scoretech/identity-internal';
import { assertCatalogueDelegation } from '../src/main/modules/catalogue/catalogue.routes.js';
import {
  validateCatalogue,
  type Catalogue,
} from '../src/main/modules/catalogue/catalogue-model.js';

const manage = 'identity:roles:manage';
const view = 'identity:users:view';
const remove = 'identity:users:delete';
const permissions = [manage, view, remove];
const manager = (
  overrides: Partial<Pick<Principal, 'roles' | 'effectiveRoleNames'>> = {},
): Pick<Principal, 'roles' | 'effectiveRoleNames'> => ({
  roles: [manage, view],
  effectiveRoleNames: [manage, view],
  ...overrides,
});

const catalogue = (): Catalogue =>
  validateCatalogue({
    defaultRole: 'member',
    permissions: permissions.map((name) => ({ name, description: name })),
    roles: [
      { name: 'administrador', description: 'Identity administrator', permissions },
      { name: 'member', description: 'Member', permissions: [] },
      { name: 'reader', description: 'User directory reader', permissions: [view] },
      { name: 'parent', description: 'Inherited reader', permissions: ['reader'] },
      { name: 'privileged', description: 'Pre-existing privileged role', permissions: [remove] },
    ],
    groups: [{ name: 'staff', roles: ['reader'] }],
  });
const role = (value: Catalogue, name: string) => value.roles.find((item) => item.name === name)!;

describe('catalogue role edits respect signed and current delegation', () => {
  it('reserves default selection and default access grants for a live identity administrator', () => {
    const previous = catalogue();
    previous.permissions.push({ name: 'sphere:access', description: '' });
    role(previous, 'administrador').permissions = previous.permissions.map(({ name }) => name);
    previous.roles.push({ name: 'public-user', description: '', permissions: ['sphere:access'] });
    const delegated = manager({
      roles: [manage, 'sphere:access'],
      effectiveRoleNames: [manage, 'sphere:access'],
    });
    for (const changeDefault of [false, true]) {
      const next = structuredClone(previous);
      if (changeDefault) next.defaultRole = 'public-user';
      else role(next, 'member').permissions = ['sphere:access'];
      const applied = validateCatalogue(next, previous);
      expect(() => assertCatalogueDelegation(delegated, applied, previous)).toThrow(
        expect.objectContaining({ status: 403, code: 'protected_configuration' }),
      );
      expect(() =>
        assertCatalogueDelegation(
          manager({ effectiveRoleNames: [manage, 'administrador'] }),
          applied,
          previous,
        ),
      ).not.toThrow();
    }
  });
  it('reserves permission deletion for the live protected administrator', () => {
    const previous = catalogue();
    previous.permissions.push({ name: 'sphere:unused', description: 'Unused' });
    role(previous, 'administrador').permissions = previous.permissions.map(
      (permission) => permission.name,
    );
    const next = structuredClone(previous);
    next.permissions = next.permissions.filter((permission) => permission.name !== 'sphere:unused');
    role(next, 'administrador').permissions = next.permissions.map((permission) => permission.name);
    expect(() => assertCatalogueDelegation(manager(), next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'protected_configuration' }),
    );
    expect(() =>
      assertCatalogueDelegation(
        manager({ effectiveRoleNames: [manage, 'administrador'] }),
        next,
        previous,
      ),
    ).not.toThrow();
  });

  it('allows a role manager without a generic administrator role to create an authorized role', () => {
    const previous = catalogue();
    const next = structuredClone(previous);
    next.roles.push({ name: 'researcher', description: 'Researcher', permissions: [view] });
    expect(() => validateCatalogue(next, previous)).not.toThrow();
    expect(() => assertCatalogueDelegation(manager(), next, previous)).not.toThrow();
    expect(manager().roles).not.toContain('administrador');
  });

  it('rejects a direct new grant outside the actor permission intersection', () => {
    const previous = catalogue();
    const next = structuredClone(previous);
    role(next, 'reader').permissions.push(remove);
    expect(() => assertCatalogueDelegation(manager(), next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
    );
  });

  it('rejects a new grant hidden behind role inheritance, including unchanged ancestors', () => {
    const previous = catalogue();
    const next = structuredClone(previous);
    role(next, 'reader').permissions = ['privileged'];
    expect(role(next, 'parent')).toEqual(role(previous, 'parent'));
    expect(() => assertCatalogueDelegation(manager(), next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
    );
  });

  it('checks new effective group grants even when no role definition changed', () => {
    const previous = catalogue();
    const next = structuredClone(previous);
    next.groups[0]!.roles.push('privileged');
    expect(next.roles).toEqual(previous.roles);
    expect(() => assertCatalogueDelegation(manager(), next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
    );
  });

  it('allows existing inherited grants to remain while unrelated metadata is edited', () => {
    const previous = catalogue();
    role(previous, 'parent').permissions = ['privileged'];
    const next = structuredClone(previous);
    role(next, 'parent').description = 'Updated description';
    expect(manager().roles).not.toContain(remove);
    expect(() => assertCatalogueDelegation(manager(), next, previous)).not.toThrow();
  });

  it('allows removing inherited grants the manager does not possess', () => {
    const previous = catalogue();
    role(previous, 'parent').permissions = ['privileged'];
    const next = structuredClone(previous);
    role(next, 'parent').permissions = [];
    expect(() => assertCatalogueDelegation(manager(), next, previous)).not.toThrow();
  });

  it('requires a newly held permission in both live state and the signed token', () => {
    const previous = catalogue();
    const next = structuredClone(previous);
    role(next, 'reader').permissions.push(remove);
    for (const actor of [
      manager({ roles: permissions }),
      manager({ effectiveRoleNames: permissions }),
    ]) {
      expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
        expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
      );
    }
    expect(() =>
      assertCatalogueDelegation(
        manager({ roles: permissions, effectiveRoleNames: permissions }),
        next,
        previous,
      ),
    ).not.toThrow();
  });

  it('rejects revoked or unavailable live catalogue management authority even for a no-op', () => {
    const previous = catalogue();
    for (const effectiveRoleNames of [undefined, [], [view]]) {
      expect(() =>
        assertCatalogueDelegation(manager({ effectiveRoleNames }), previous, previous),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
      );
    }
    expect(() =>
      assertCatalogueDelegation(manager({ roles: [view] }), previous, previous),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it('protects administrator group membership even if the group already held the same atomic grants', () => {
    const previous = catalogue();
    previous.roles.push({ name: 'all-grants', description: '', permissions });
    previous.groups[0]!.roles = ['all-grants'];
    const next = structuredClone(previous);
    next.groups[0]!.roles = ['administrador'];
    const delegated = manager({ roles: permissions, effectiveRoleNames: permissions });
    expect(() => assertCatalogueDelegation(delegated, next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'protected_role' }),
    );
    expect(() =>
      assertCatalogueDelegation(
        manager({ roles: permissions, effectiveRoleNames: [...permissions, 'administrador'] }),
        next,
        previous,
      ),
    ).not.toThrow();
  });
});

describe('permission declarations and client access rules require protected authority', () => {
  const protectedManager = () => manager({ effectiveRoleNames: [...permissions, 'administrador'] });
  const applicationPermission = 'sphere:local:access';
  const declarePermission = (previous: Catalogue): Catalogue =>
    validateCatalogue(
      {
        ...previous,
        permissions: [
          ...previous.permissions,
          { name: applicationPermission, description: 'Use SPHERE' },
        ],
      },
      previous,
    );
  const accessRule = () => ({
    id: 'sphere-local',
    clientId: 'sphere-web',
    origin: 'https://sphere.score.us.es',
    requiredPermissions: [view, remove],
  });

  it('allows protected administrator coverage of a newly declared atom absent from the signed token', () => {
    const previous = catalogue();
    const next = declarePermission(previous);
    const actor = protectedManager();
    expect(actor.roles).not.toContain(applicationPermission);
    expect(actor.effectiveRoleNames).not.toContain(applicationPermission);
    expect(role(next, 'administrador').permissions).toContain(applicationPermission);
    expect(() => assertCatalogueDelegation(actor, next, previous)).not.toThrow();
  });

  it('allows automatic new-atom coverage inherited by an unchanged protected administrator group', () => {
    const previous = catalogue();
    previous.groups.push({ name: 'identity-administrators', roles: ['administrador'] });
    const next = declarePermission(previous);
    expect(next.groups).toEqual(previous.groups);
    expect(protectedManager().roles).not.toContain(applicationPermission);
    expect(() => assertCatalogueDelegation(protectedManager(), next, previous)).not.toThrow();
  });

  it('allows a current full administrator to grant a newly protected group without a fresh atom claim', () => {
    const previous = catalogue();
    const next = declarePermission(previous);
    next.groups.push({ name: 'new-administrators', roles: ['administrador'] });
    const actor = manager({
      roles: permissions,
      effectiveRoleNames: [...permissions, 'administrador'],
    });
    expect(actor.roles).not.toContain(applicationPermission);
    expect(() => assertCatalogueDelegation(actor, next, previous)).not.toThrow();
  });

  it('rejects new atom declarations by a delegated manager even if it claims every atom', () => {
    const previous = catalogue();
    const next = declarePermission(previous);
    const actor = manager({
      roles: [...permissions, applicationPermission, 'administrador'],
      effectiveRoleNames: [...permissions, applicationPermission],
    });
    expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'protected_configuration' }),
    );
  });

  it.each(['neither', 'signed-only', 'live-only'])(
    'allows a current full administrator to declare and delegate an atom in the same publication (%s atomic claims)',
    (proof) => {
      const previous = catalogue();
      const next = declarePermission(previous);
      role(next, 'reader').permissions.push(applicationPermission);
      const actor = protectedManager();
      if (proof === 'signed-only') actor.roles.push(applicationPermission);
      if (proof === 'live-only') actor.effectiveRoleNames!.push(applicationPermission);
      expect(() => validateCatalogue(next, previous)).not.toThrow();
      expect(() => assertCatalogueDelegation(actor, next, previous)).not.toThrow();
    },
  );

  it('allows a current full administrator to delegate a previously declared permission missing from its old token', () => {
    const previous = declarePermission(catalogue());
    const next = structuredClone(previous);
    role(next, 'reader').permissions.push(applicationPermission);
    const actor = protectedManager();
    expect(actor.roles).not.toContain(applicationPermission);
    expect(() => assertCatalogueDelegation(actor, next, previous)).not.toThrow();
  });

  it.each(['neither', 'signed-only', 'live-only'])(
    'keeps delegated operators bounded by signed and live atomic permission claims (%s)',
    (proof) => {
      const previous = declarePermission(catalogue());
      const next = structuredClone(previous);
      role(next, 'reader').permissions.push(applicationPermission);
      const actor = manager();
      if (proof === 'signed-only') actor.roles.push(applicationPermission);
      if (proof === 'live-only') actor.effectiveRoleNames!.push(applicationPermission);
      expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
        expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
      );
    },
  );

  it('allows a delegated operator to grant the atom only when both signed and live permissions include it', () => {
    const previous = declarePermission(catalogue());
    const next = structuredClone(previous);
    role(next, 'reader').permissions.push(applicationPermission);
    const actor = manager();
    actor.roles.push(applicationPermission);
    actor.effectiveRoleNames!.push(applicationPermission);
    expect(() => assertCatalogueDelegation(actor, next, previous)).not.toThrow();
  });

  it('does not retain full-administrator authority after the protected role is revoked live', () => {
    const previous = declarePermission(catalogue());
    const next = structuredClone(previous);
    role(next, 'reader').permissions.push(applicationPermission);
    const actor = manager({ roles: [...permissions, 'administrador'] });
    expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
      expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
    );
  });

  it.each(['admin', 'realm-admin', 'identity-admin'])(
    'does not infer full-administrator authority from the unrelated live role %s',
    (unrelated) => {
      const previous = declarePermission(catalogue());
      const next = structuredClone(previous);
      role(next, 'reader').permissions.push(applicationPermission);
      const actor = manager({ effectiveRoleNames: [...permissions, unrelated] });
      expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
        expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
      );
    },
  );

  it.each(['declaration', 'access-rule', 'ordinary-role'])(
    'still requires signed and live catalogue management for a protected %s change',
    (change) => {
      const previous = change === 'ordinary-role' ? declarePermission(catalogue()) : catalogue();
      const next =
        change === 'declaration'
          ? declarePermission(previous)
          : change === 'access-rule'
            ? { ...previous, accessRules: [accessRule()] }
            : structuredClone(previous);
      if (change === 'ordinary-role') role(next, 'reader').permissions.push(applicationPermission);
      for (const actor of [
        manager({ roles: [view], effectiveRoleNames: [...permissions, 'administrador'] }),
        manager({ effectiveRoleNames: [view, 'administrador'] }),
        manager({ effectiveRoleNames: undefined }),
      ])
        expect(() => assertCatalogueDelegation(actor, next, previous)).toThrowError(
          expect.objectContaining({ status: 403, code: 'catalogue_delegation_forbidden' }),
        );
    },
  );

  it.each(['add', 'weaken', 'delete', 'retarget-client', 'retarget-origin'])(
    'forbids delegated application access rule changes (%s)',
    (change) => {
      const previous = { ...catalogue(), accessRules: change === 'add' ? [] : [accessRule()] };
      const next = structuredClone(previous);
      if (change === 'add') next.accessRules.push(accessRule());
      else if (change === 'weaken') next.accessRules[0]!.requiredPermissions = [view];
      else if (change === 'delete') next.accessRules = [];
      else if (change === 'retarget-client') next.accessRules[0]!.clientId = 'space-web';
      else next.accessRules[0]!.origin = 'https://space.score.us.es';
      const delegated = manager({
        roles: [...permissions, 'administrador'],
        effectiveRoleNames: permissions,
      });
      expect(() => assertCatalogueDelegation(delegated, next, previous)).toThrowError(
        expect.objectContaining({ status: 403, code: 'protected_configuration' }),
      );
      expect(() => assertCatalogueDelegation(protectedManager(), next, previous)).not.toThrow();
    },
  );

  it('allows delegated role changes while existing protected client rules remain unchanged', () => {
    const previous = { ...catalogue(), accessRules: [accessRule()] };
    const next = structuredClone(previous);
    next.roles.push({ name: 'directory-reader', description: '', permissions: [view] });
    expect(() => assertCatalogueDelegation(manager(), next, previous)).not.toThrow();
  });
});
