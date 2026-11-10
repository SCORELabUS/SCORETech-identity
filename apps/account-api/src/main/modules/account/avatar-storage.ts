import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { HttpError } from '@scoretech/identity-internal';

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = 5 * 1024 * 1024;

export class AvatarStorage {
  private readonly client: S3Client;

  public constructor(
    private readonly bucket: string,
    region: string,
    options: Pick<S3ClientConfig, 'endpoint' | 'forcePathStyle'> = {},
  ) {
    this.client = new S3Client({ region, ...options });
  }

  public async save(subject: string, bytes: Buffer): Promise<string> {
    const key = `avatars/${subject}/${randomUUID()}.webp`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'image/webp',
      }),
    );
    return key;
  }

  public async createUpload(
    subject: string,
    contentType: string,
  ): Promise<{ key: string; url: string }> {
    if (!allowedTypes.has(contentType))
      throw new HttpError(400, 'invalid_avatar_image', 'Use a JPEG, PNG or WebP image.');
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const key = `avatars/${subject}/${randomUUID()}.${extension}`;
    return {
      key,
      url: await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
        { expiresIn: 300 },
      ),
    };
  }

  public async assertOwnedImage(subject: string, key: string): Promise<void> {
    if (!key.startsWith(`avatars/${subject}/`))
      throw new HttpError(
        400,
        'invalid_avatar_image',
        'The image does not belong to your account.',
      );
    try {
      const object = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (
        !allowedTypes.has(object.ContentType ?? '') ||
        !object.ContentLength ||
        object.ContentLength > maxBytes
      )
        throw new HttpError(
          400,
          'invalid_avatar_image',
          'The image does not meet the requirements.',
        );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'invalid_avatar_image', 'The uploaded image was not found.');
    }
  }

  public signedReadUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 300,
    });
  }

  public async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
