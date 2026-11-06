import { describe, it, expect } from 'vitest';
import { AvatarStorage } from '../src/main/modules/account/avatar-storage.js';
describe('avatar ownership', () => {
  it('rejects another subject before requesting S3', async () => {
    await expect(
      new AvatarStorage('fixture', 'eu-south-2').assertOwnedImage(
        'owner',
        'avatars/foreign/image.jpg',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects unsupported upload types before signing', async () => {
    await expect(
      new AvatarStorage('fixture', 'eu-south-2').createUpload('owner', 'text/html'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
