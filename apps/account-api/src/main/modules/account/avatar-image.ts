import sharp from 'sharp';
import type { AppConfig } from '../../config/app-config.js';
import { AvatarStorage } from './avatar-storage.js';
import { LocalAvatarStorage } from './local-avatar-storage.js';

export function avatarStorage(config: AppConfig) {
  if (config.APP_AVATAR_BUCKET)
    return new AvatarStorage(config.APP_AVATAR_BUCKET, config.APP_AVATAR_REGION, {
      endpoint: config.APP_AVATAR_ENDPOINT,
      forcePathStyle: config.APP_AVATAR_FORCE_PATH_STYLE,
    });
  if (config.APP_AVATAR_DIRECTORY) return new LocalAvatarStorage(config.APP_AVATAR_DIRECTORY);
}

export async function normalizeAvatarImage(input: Buffer) {
  const image = sharp(input, { limitInputPixels: 16_000_000, animated: false });
  const meta = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
    throw new Error('Invalid image');
  return image.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 90 }).toBuffer();
}
