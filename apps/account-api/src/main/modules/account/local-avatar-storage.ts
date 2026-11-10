import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '@scoretech/identity-internal';

/** Private, persistent storage for a single-machine deployment; no public file paths. */
export class LocalAvatarStorage {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    if (!/^avatars\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.webp$/.test(key))
      throw new HttpError(400, 'invalid_avatar_image', 'Invalid avatar image.');
    return resolve(this.directory, key);
  }
  async save(subject: string, bytes: Buffer): Promise<string> {
    const key = `avatars/${subject}/${randomUUID()}.webp`;
    const path = this.path(key);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return key;
  }
  async assertOwnedImage(subject: string, key: string): Promise<void> {
    if (!key.startsWith(`avatars/${subject}/`))
      throw new HttpError(
        400,
        'invalid_avatar_image',
        'The image does not belong to your account.',
      );
    try {
      await readFile(this.path(key));
    } catch {
      throw new HttpError(400, 'invalid_avatar_image', 'The uploaded image was not found.');
    }
  }
  async signedReadUrl(key: string): Promise<string> {
    // Returned only in the authenticated owner's no-store profile response.
    return 'data:image/webp;base64,' + (await readFile(this.path(key))).toString('base64');
  }
  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch((error: { code?: string }) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
