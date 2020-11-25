import { Auth } from '@daaku/firebase-auth';
import { FirebaseStorageClient } from '@daaku/firebase-storage';
import { deleteDB, IDBPDatabase, openDB } from 'idb';
import { customAlphabet } from 'nanoid/index.js';

import { CompleteEvent, ErrorEvent, FirebaseBlobDB } from '../src';

const nanoid = customAlphabet('abcdefghijklmnopqrstvwxyz', 16);

async function makeClient(
  onError: (ev: ErrorEvent) => void,
  onComplete: (ev: CompleteEvent) => void,
): Promise<[Auth, FirebaseBlobDB, IDBPDatabase, string]> {
  const auth = await Auth.new({
    apiKey: 'AIzaSyCnFgFqO3d7RbJDcNAp_eO21KSOISCP9IU',
  });
  const client = new FirebaseStorageClient({
    storageBucket: 'fidb-unit-test.appspot.com',
    tokenSource: auth.getBearerToken.bind(auth),
  });
  const dbName = nanoid();
  const blobDB = new FirebaseBlobDB({
    client: client,
    onError,
    onComplete,
  });
  const db = await openDB(dbName, 1, {
    upgrade: (db) => {
      blobDB.upgradeDB(db);
    },
  });
  blobDB.setDB(db);
  return [auth, blobDB, db, dbName];
}

function sleep(delay: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, delay);
  });
}

QUnit.test('do flow', async (assert) => {
  const path = nanoid();
  const done = assert.async();
  const [auth, blobDB, db, dbName] = await makeClient(
    (ev) => {
      console.error('error event', ev);
      assert.notOk(ev, 'unexpected onError event');
    },
    async (ev) => {
      assert.equal(ev.path, path, 'expecte complete event with path');
      const url = await blobDB.downloadURL(path);
      assert.ok(url.startsWith('https:'), 'expect a https URL');
      await blobDB.delete(path);
      // wait until it's deleted, then we're good
      while (true) {
        await sleep(100);
        if (!(await db.get('blob_queue', path))) {
          break;
        }
      }
      db.close();
      deleteDB(dbName);
      await auth.delete();
      done();
    },
  );
  await auth.signUp({});
  const input = { hello: 'world' };
  const blob = new Blob([JSON.stringify(input, null, 2)], {
    type: 'application/json',
  });
  const url = await blobDB.upload(path, blob);
  assert.ok(url.startsWith('blob:'), 'expect a blob URL');
});
