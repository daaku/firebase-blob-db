import {
  downloadURL,
  FirebaseStorageClient,
  FirebaseUploadMetadata,
  FirebaseUploadState,
} from '@daaku/firebase-storage';
import type { IDBPDatabase } from 'idb';

export interface ErrorEvent {
  path: string;
  error: unknown;
}

export interface CompleteEvent {
  path: string;
}

interface Existing {
  path: string;
  downloadURL: string;
}

interface PendingUpload {
  path: string;
  action: 'upload';
  metadata: FirebaseUploadMetadata;
  state?: FirebaseUploadState;
}

interface PendingDelete {
  path: string;
  action: 'delete';
}

type Pending = PendingUpload | PendingDelete;

// Config to initialize a FirebaseBlobDB.
export interface FirebaseBlobDBConfig {
  client: FirebaseStorageClient;
  onError: (ev: ErrorEvent) => void;
  onComplete: (ev: CompleteEvent) => void;
  blobInfoStoreName?: string;
  blobCacheStoreName?: string;
  blobQueueStoreName?: string;
}

// Resilient uploading of blobs to Firebase Storage.
export class FirebaseBlobDB {
  private db!: IDBPDatabase;
  private client: FirebaseStorageClient;
  private onError: (ev: ErrorEvent) => void;
  private onComplete: (ev: CompleteEvent) => void;
  private blobInfoStoreName: string;
  private blobCacheStoreName: string;
  private blobQueueStoreName: string;
  private running = false;

  constructor(config: FirebaseBlobDBConfig) {
    this.client = config.client;
    this.onError = config.onError;
    this.onComplete = config.onComplete;
    this.blobInfoStoreName = config.blobInfoStoreName ?? 'blob_info';
    this.blobCacheStoreName = config.blobCacheStoreName ?? 'blob_cache';
    this.blobQueueStoreName = config.blobQueueStoreName ?? 'blob_queue';
  }

  // Call this in your upgradeDB transaction.
  public upgradeDB(db: IDBPDatabase): void {
    [this.blobInfoStoreName, this.blobQueueStoreName].forEach((name) => {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, { keyPath: 'path' });
      }
    });

    // this one stores blobs directly
    if (!db.objectStoreNames.contains(this.blobCacheStoreName)) {
      db.createObjectStore(this.blobCacheStoreName);
    }
  }

  // This should be called with the initialized DB before you begin using the
  // instance.
  public setDB(db: IDBPDatabase): void {
    this.db = db;
    this.run();
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    while (true) {
      const pending = (await this.db.getAll(
        this.blobQueueStoreName,
        undefined,
        1,
      )) as Pending[];
      if (pending.length === 0) {
        break;
      }
      try {
        await this.runPending(pending[0]);
      } catch (err) {
        // TODO: handle errors correctly
        this.onError({
          path: pending[0].path,
          error: err,
        });
        // TODO: schedule a retry? delete the offending item? something?
        break;
      }
    }
    this.running = false;
  }

  private async runPending(pending: Pending): Promise<void> {
    if (pending.action === 'delete') {
      await this.client.delete(pending.path);
      await this.db.delete(this.blobQueueStoreName, pending.path);
      return;
    }

    if (pending.action === 'upload') {
      const blob = (await this.db.get(
        this.blobCacheStoreName,
        pending.path,
      )) as Blob;

      let state: FirebaseUploadState;
      if (pending.state) {
        state = pending.state;
      } else {
        // start a new upload
        state = await this.client.uploadStart(
          pending.path,
          blob,
          pending.metadata,
        );
        // store the state so we can resume it later if needed
        await this.db.put(this.blobQueueStoreName, {
          ...pending,
          state,
        });
      }

      // finish uploading this blob if we can
      while (true) {
        // we have at least one more chunk to upload
        const result = await this.client.uploadChunk(state, blob);

        // successfully uploaded last chunk, we're done with this upload
        if (result.type === 'finish') {
          const cache: Existing = {
            path: pending.path,
            downloadURL: downloadURL(result.metadata),
          };
          const t = this.db.transaction(
            [
              this.blobCacheStoreName,
              this.blobQueueStoreName,
              this.blobInfoStoreName,
            ],
            'readwrite',
          );
          await t.objectStore(this.blobInfoStoreName).put(cache);
          await t.objectStore(this.blobQueueStoreName).delete(pending.path);
          await t.objectStore(this.blobCacheStoreName).delete(pending.path);
          await t.done;
          this.onComplete({ path: pending.path });
          return;
        }

        // successfully uploaded one chunk, store our progress and continue the loop
        if (result.type === 'continue') {
          await this.db.put(this.blobQueueStoreName, {
            ...pending,
            state: result.state,
          });
          state = result.state;
        }
      }
    }

    throw new Error('unreachable');
  }

  // Upload schedules uploading of the blob to the path at a later time.
  // Returns a URL that can be used to serve the asset immediately. The URL is
  // ephemeral, and should not be stored. Instead store the path you provided
  // and use the downloadURL method whenever you need one at some point in the
  // future.
  public async upload(
    path: string,
    blob: Blob,
    metadata: FirebaseUploadMetadata = {},
  ): Promise<string> {
    const pending: PendingUpload = { action: 'upload', path, metadata };
    const t = this.db.transaction(
      [this.blobCacheStoreName, this.blobQueueStoreName],
      'readwrite',
    );
    await t.objectStore(this.blobCacheStoreName).put(blob, path);
    await t.objectStore(this.blobQueueStoreName).put(pending);
    await t.done;
    this.run();
    return URL.createObjectURL(blob);
  }

  // Delete a path locally and in Firebase.
  public async delete(path: string): Promise<void> {
    const pending: PendingDelete = { action: 'delete', path };
    const t = this.db.transaction(
      [
        this.blobCacheStoreName,
        this.blobInfoStoreName,
        this.blobQueueStoreName,
      ],
      'readwrite',
    );
    await t.objectStore(this.blobCacheStoreName).delete(path);
    await t.objectStore(this.blobInfoStoreName).delete(path);
    await t.objectStore(this.blobQueueStoreName).put(pending);
    await t.done;
    this.run();
  }

  // Get the downloadURL for the path from our local cache, or pending upload,
  // or a blob stored in Firebase.
  public async downloadURL(path: string): Promise<string> {
    // check if we have it in cache
    const blob = (await this.db.get(this.blobCacheStoreName, path)) as Blob;
    if (blob) {
      return URL.createObjectURL(blob);
    }

    // check if we have the downloadURL
    const existing = (await this.db.get(
      this.blobInfoStoreName,
      path,
    )) as Existing;
    if (existing) {
      return existing.downloadURL;
    }

    // fetch and cache downloadURL
    const downloadURL = await this.client.downloadURL(path);
    const cache: Existing = { path, downloadURL };
    await this.db.put(this.blobInfoStoreName, cache);
    return downloadURL;
  }
}
