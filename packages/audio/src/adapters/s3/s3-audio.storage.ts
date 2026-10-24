import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { PLAYBACK_URL_TTL_SECONDS, type AudioObjectStore } from '../../audio.port.js';

export interface S3AudioStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
}

/** Private S3-compatible object adapter; AWS credentials come from the SDK chain. */
export class S3AudioStorage implements AudioObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly config: S3AudioStorageConfig,
    clientConfig: S3ClientConfig = {},
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      ...clientConfig,
    });
  }

  async putObject(input: Parameters<AudioObjectStore['putObject']>[0]): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async createPlaybackUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: PLAYBACK_URL_TTL_SECONDS },
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
