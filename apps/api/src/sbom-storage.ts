import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

export interface SbomStorageConfig {
  /** S3 endpoint the browser can reach: it is embedded in the upload URL. */
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

/**
 * The API's only contact with SBOM bytes is signing the upload, checking an object exists, and
 * deleting it. The key is always passed in by the caller (built from internal IDs), never derived
 * from client input.
 */
export function createSbomStorage(config: SbomStorageConfig) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
  });
  const Bucket = config.bucket;

  return {
    bucket: Bucket,

    /** A POST policy pins the key and caps the body size, so storage rejects an oversize upload. */
    signUpload(key: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload> {
      return createPresignedPost(client, {
        Bucket,
        Key: key,
        Conditions: [["content-length-range", 1, maxBytes]],
        Expires: ttlSeconds,
      });
    },

    /** The stored object's size, or undefined if it is not there. */
    async size(key: string): Promise<number | undefined> {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return head.ContentLength;
      } catch (err) {
        if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) {
          return undefined;
        }
        throw err;
      }
    },

    async remove(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    /** Local development: create the bucket and let the web origin post to it. Not for deployed environments. */
    async ensureDevBucket(allowedOrigin: string): Promise<void> {
      try {
        await client.send(new CreateBucketCommand({ Bucket }));
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
      }
      await client.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              { AllowedOrigins: [allowedOrigin], AllowedMethods: ["POST"], AllowedHeaders: ["*"] },
            ],
          },
        }),
      );
    },

    destroy: () => client.destroy(),
  };
}

export type SbomStorage = ReturnType<typeof createSbomStorage>;
