import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeycloakAdminClient } from '@scoretech/identity-internal';
import { z } from 'zod';
import { loadConfig } from './config/app-config.js';
import { avatarStorage, normalizeAvatarImage } from './modules/account/avatar-image.js';
import { SharedProfileSchema, SocialLinksSchema } from './modules/account/shared-profile.js';

const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const colors = { backgroundColor: color, foregroundColor: color };
const Avatar = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initials'), ...colors }),
  z.object({ kind: z.literal('icon'), assetId: z.string().regex(/^avatar-(?:[1-4]|[6-9]|10)$/), ...colors }),
  z.object({ kind: z.literal('photo'), bytes: z.string().max(2_796_204).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
]);
const Snapshot = z.object({
  issuer: z.string().url(),
  profiles: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    profile: z.record(z.unknown()).nullish(),
    socialLinks: z.record(z.unknown()).nullish(),
    phone: z.unknown().optional(),
    avatar: Avatar.optional(),
  })),
});
type Profile = z.infer<typeof Snapshot>['profiles'][number];
type Attributes = Record<string, string[]>;

function attributeGroup(shape: z.ZodRawShape, values: Record<string, unknown>, id: string) {
  const entries: [string, string][] = [];
  for (const [name, rule] of Object.entries(shape)) {
    if (values[name] === undefined || values[name] === null) continue;
    const value = rule.safeParse(values[name]);
    if (!value.success) console.error(`SPHERE user ${id}: unsupported ${name} value skipped.`);
    else if (typeof value.data === 'string' && value.data) entries.push([name, value.data]);
  }
  return entries.length ? [JSON.stringify(Object.fromEntries(entries))] : undefined;
}

function defaultsFor(source: Profile, existing: Attributes) {
  const defaults: Attributes = {};
  if (!existing.scoreProfile && source.profile) {
    const values = attributeGroup(SharedProfileSchema.shape, source.profile, source.id);
    if (values) defaults.scoreProfile = values;
  }
  if (!existing.scoreSocialLinks && source.socialLinks) {
    const values = attributeGroup(SocialLinksSchema.shape, source.socialLinks, source.id);
    if (values) defaults.scoreSocialLinks = values;
  }
  if (!existing.tentuPhone && typeof source.phone === 'string' && source.phone) {
    const phone = source.phone.trim().replace(/[\s()-]/g, '');
    if (/^\+?[1-9][0-9]{6,14}$/.test(phone)) defaults.tentuPhone = [phone];
    else console.error(`SPHERE user ${source.id}: unsupported phone value skipped.`);
  }
  if (!existing.tentuAvatar && source.avatar && source.avatar.kind !== 'photo') {
    defaults.tentuAvatar = [JSON.stringify(source.avatar)];
  }
  return defaults;
}

async function main(apply: boolean) {
  const snapshot = Snapshot.parse(JSON.parse(readFileSync(0, 'utf8')));
  const config = loadConfig();
  const issuer = config.APP_KEYCLOAK_ISSUER.replace(/\/$/, '');
  if (snapshot.issuer !== issuer) throw new Error('Issuer mismatch.');
  const client = new KeycloakAdminClient({
    issuer,
    transportUrl: config.APP_KEYCLOAK_TRANSPORT_URL,
    adminUrl: config.APP_KEYCLOAK_ADMIN_URL,
    realm: config.APP_KEYCLOAK_REALM,
    clientId: config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
    clientSecret: config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
  });
  const storage = avatarStorage(config);
  const subjects = new Map<string, string>();
  for (let first = 0; ; first += 100) {
    const users = await client.listUsers(undefined, first, 100);
    for (const user of users) {
      const binding = createHash('sha256').update(JSON.stringify([issuer, user.id])).digest('hex');
      subjects.set(binding, user.id);
    }
    if (users.length < 100) break;
  }
  const targets = [];
  const seen = new Set<string>();
  let conflicts = 0;
  for (const source of snapshot.profiles) {
    const subject = subjects.get(source.binding);
    if (!subject || seen.has(subject)) {
      console.error(`SPHERE user ${source.id}: SCORETech link is missing or ambiguous.`);
      conflicts++;
      continue;
    }
    seen.add(subject);
    const user = await client.getUser(subject);
    const attributes = user.attributes ?? {};
    const defaults = defaultsFor(source, attributes);
    let photo: Buffer | undefined;
    if (!attributes.tentuAvatar && source.avatar?.kind === 'photo') {
      if (!storage) throw new Error('SCORETech avatar storage is unavailable.');
      try { photo = await normalizeAvatarImage(Buffer.from(source.avatar.bytes, 'base64')); }
      catch { console.error(`SPHERE user ${source.id}: unsupported avatar image skipped.`); }
    }
    if (photo || Object.keys(defaults).length) targets.push({ subject, defaults, photo });
  }
  console.log(`Linked profiles: ${snapshot.profiles.length}. To fill: ${targets.length}. Avatars: ${targets.filter(({ defaults, photo }) => photo || defaults.tentuAvatar).length}. Conflicts: ${conflicts}.`);
  if (conflicts) throw new Error('Resolve missing or ambiguous SCORETech links first.');
  if (!apply) return;

  let updated = 0;
  for (const { subject, defaults, photo } of targets) {
    const key = photo && storage ? await storage.save(subject, photo) : undefined;
    if (key) defaults.tentuAvatar = [JSON.stringify({ kind: 'photo', imageKey: key })];
    try {
      await client.updateUser(subject, { attributeDefaults: defaults });
    } finally {
      // When the update result is uncertain, keep the image until its reference can be checked.
      if (key && storage) {
        const user = await client.getUser(subject).catch(() => undefined);
        if (user && user.attributes?.tentuAvatar?.[0] !== defaults.tentuAvatar?.[0])
          await storage.delete(key);
      }
    }
    updated++;
  }
  console.log(`Processed ${updated} SCORETech profiles.`);
}

const mode = process.argv[2];
if (mode !== '--plan' && mode !== '--apply') {
  console.error('Use --plan or --apply.');
  process.exitCode = 2;
} else {
  main(mode === '--apply').catch(() => {
    console.error('Profile import stopped. Check the issuer, linked users, provider version and avatar storage, then rerun.');
    process.exitCode = 1;
  });
}
