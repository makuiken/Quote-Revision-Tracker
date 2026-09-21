import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { File, Storage } from '@google-cloud/storage';

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from './objectAcl';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

export const objectStorageClient = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  async checkReady(): Promise<void> {
    const path = `/objects/system/readiness/${randomUUID()}`;
    let written = false;
    try {
      await this.saveObjectEntityImmutable(
        path,
        new TextEncoder().encode("ready"),
        "text/plain",
        3_000,
      );
      written = true;
      const metadata = await this.getObjectEntityMetadata(path, 3_000);
      if (metadata.size !== 5 || !metadata.generation) {
        throw new Error("Object storage readiness verification failed.");
      }
    } finally {
      if (written) await this.deleteObjectEntity(path, 3_000);
    }
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(
    file: File,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === 'public';

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      'Content-Type':
        (metadata.contentType as string) || 'application/octet-stream',
      'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers['Content-Length'] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  /**
   * Generates a PUT URL for a server-selected private path. Callers must never
   * pass a browser-controlled path here: packet uploads use this to bind the
   * one-time upload URL to a quote and packet row before bytes arrive.
   */
  async getObjectEntityUploadURLForPath(objectPath: string): Promise<string> {
    const file = this.getObjectEntityFileReference(objectPath);
    const { bucketName, objectName } = parseObjectPath(
      `/${file.bucket.name}/${file.name}`,
    );
    return signObjectURL({ bucketName, objectName, method: 'PUT', ttlSec: 900 });
  }

  private getObjectEntityFileReference(objectPath: string): File {
    if (
      !objectPath.startsWith('/objects/') ||
      objectPath.includes('..') ||
      objectPath.includes('\\')
    ) {
      throw new ObjectNotFoundError();
    }
    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2 || parts.slice(1).some((part) => !part)) {
      throw new ObjectNotFoundError();
    }

    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${parts.slice(1).join('/')}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    const objectFile = this.getObjectEntityFileReference(objectPath);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  async downloadObjectBytes(objectPath: string): Promise<Buffer> {
    const file = await this.getObjectEntityFile(objectPath);
    const [bytes] = await file.download();
    return bytes;
  }

  async getObjectEntityMetadata(objectPath: string, timeout = 30_000): Promise<{
    size: number;
    generation: string | undefined;
    contentType: string | undefined;
  }> {
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata({ timeout });
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Object has an invalid size.");
    }
    return {
      size,
      generation: metadata.generation ? String(metadata.generation) : undefined,
      contentType: metadata.contentType ? String(metadata.contentType) : undefined,
    };
  }

  async downloadObjectBytesBounded(
    objectPath: string,
    maxBytes: number,
    options: { signal?: AbortSignal; deadlineAt?: number } = {},
  ): Promise<Buffer> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Download cancelled.");
    const remaining = options.deadlineAt === undefined
      ? 30_000
      : Math.max(1, Math.min(30_000, options.deadlineAt - Date.now()));
    const metadata = await this.getObjectEntityMetadata(objectPath, remaining);
    if (metadata.size > maxBytes) throw new Error("Object exceeds the allowed size.");
    const file = await this.getObjectEntityFile(objectPath);
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = file.createReadStream();
    const deadlineTimer = options.deadlineAt === undefined
      ? undefined
      : setTimeout(
          () => stream.destroy(new Error("Object download deadline exceeded.")),
          Math.max(0, options.deadlineAt - Date.now()),
        );
    deadlineTimer?.unref?.();
    const onAbort = () => stream.destroy(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("Object download cancelled."),
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          stream.destroy(new Error("Object exceeded the allowed size while downloading."));
          throw new Error("Object exceeds the allowed size.");
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks, total);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Copies uploaded bytes to a distinct immutable key. The generation
   * precondition means a retry can never replace a source or approved render.
   */
  async copyObjectEntityImmutable(
    sourcePath: string,
    destinationPath: string,
    sourceGeneration?: string,
  ): Promise<void> {
    const sourceReference = await this.getObjectEntityFile(sourcePath);
    const source = sourceGeneration
      ? sourceReference.bucket.file(sourceReference.name, {
          generation: sourceGeneration,
        })
      : sourceReference;
    const destination = this.getObjectEntityFileReference(destinationPath);
    await source.copy(destination, {
      preconditionOpts: {
        ifGenerationMatch: 0,
      },
    });
  }

  async saveObjectEntityImmutable(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
    timeout = 30_000,
  ): Promise<void> {
    const file = this.getObjectEntityFileReference(objectPath);
    await file.save(Buffer.from(bytes), {
      contentType,
      resumable: false,
      timeout,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  }

  /**
   * Remove a private object only when a lifecycle operation has not committed
   * a database reference to it. Template saves use this for best-effort
   * cleanup of an immutable copy after a conflict/transaction failure; the
   * source object uploaded to a draft is never deleted as historical evidence.
   */
  async deleteObjectEntity(objectPath: string, timeout = 30_000): Promise<void> {
    const file = this.getObjectEntityFileReference(objectPath);
    if (timeout < 30_000) {
      const { bucketName, objectName } = parseObjectPath(`/${file.bucket.name}/${file.name}`);
      const signedUrl = await signObjectURL({
        bucketName,
        objectName,
        method: 'DELETE',
        ttlSec: 30,
      });
      const response = await fetch(signedUrl, {
        method: 'DELETE',
        signal: AbortSignal.timeout(timeout),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) {
        throw new Error(`Object deletion returned ${response.status}.`);
      }
      return;
    }
    await file.delete({ ignoreNotFound: true });
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/')) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }

  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}
