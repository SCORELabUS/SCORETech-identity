import { z } from 'zod';

// SPHERE's social profile shapes, restricted to known networks and safe links.
const patterns = {
  linkedin: /^https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[\w\-%.]+\/?$/,
  instagram: /^https?:\/\/(www\.)?instagram\.com\/[\w%.]+\/?$/,
  facebook: /^https?:\/\/(www\.)?facebook\.com\/(?:[\w%.]+|pages\/[\w\-%.]+\/\d+)\/?$/,
  x: /^https?:\/\/(www\.)?(x|twitter)\.com\/\w+\/?$/,
};
const social = (network: keyof typeof patterns) =>
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => !value || patterns[network].test(value),
      `Enter a valid ${network === 'x' ? 'X / Twitter' : network} profile URL.`,
    )
    .default('');
export const SocialLinksSchema = z
  .object({
    linkedin: social('linkedin'),
    instagram: social('instagram'),
    facebook: social('facebook'),
    x: social('x'),
  })
  .strict();
const dateOfBirth = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= '1900-01-01' &&
    value <= new Date().toISOString().slice(0, 10)
  );
}, 'Enter a valid date of birth in the past.');
export const SharedProfileSchema = z
  .object({
    displayName: z.string().trim().max(100).default(''),
    bio: z.string().trim().max(200).default(''),
    city: z.string().trim().max(100).default(''),
    country: z.string().trim().max(100).default(''),
    dateOfBirth: dateOfBirth.default(''),
  })
  .strict();
export function readSharedProfile(attributes?: Record<string, string[]>) {
  const parse = <T>(value: string | undefined, schema: z.ZodType<T>) => {
    try {
      return schema.parse(JSON.parse(value || '{}'));
    } catch {
      return schema.parse({});
    }
  };
  return {
    profile: parse(attributes?.scoreProfile?.[0], SharedProfileSchema),
    socialLinks: parse(attributes?.scoreSocialLinks?.[0], SocialLinksSchema),
  };
}
