import { z } from 'zod';
const Preferences = z.object({ theme: z.enum(['light', 'dark']) }).strict();
export const PreferencesWriteSchema = Preferences;
export function readPreferences(attributes: Record<string, string[]> = {}) {
  try {
    const parsed: unknown = JSON.parse(attributes.tentuPreferences?.[0] ?? 'null');
    return Preferences.parse(parsed);
  } catch { return { theme: 'light' as const }; }
}
