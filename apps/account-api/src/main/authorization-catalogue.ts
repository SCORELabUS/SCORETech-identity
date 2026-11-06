import { readFileSync } from 'node:fs';
import { z } from 'zod';
const CatalogueSchema = z
  .object({ permissions: z.array(z.string()), roles: z.array(z.string()) })
  .strict();
export const loadAuthorizationCatalogue = (path: string) =>
  CatalogueSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
