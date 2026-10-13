// A small IndexedDB wrapper. Everything stays in this browser (or in the
// desktop app's own storage). Failures are swallowed by callers: storage can be
// unavailable (private windows) and Nib-E must keep working without it.

const DB_NAME = 'nib';
const DB_VERSION = 1;
export type StoreName = 'books' | 'recovery' | 'backups';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['books', 'recovery', 'backups'] as StoreName[]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is blocked by another Nib-E window.'));
  });
  dbp.catch(() => {
    dbp = null;
  });
  return dbp;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage write aborted (disk full?)'));
  });
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await open();
  await done(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function idbAll<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  const db = await open();
  const os = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  return keys.map((k, i) => ({ key: String(k), value: values[i] as T }));
}

export async function idbClear(): Promise<void> {
  const db = await open();
  for (const s of ['books', 'recovery', 'backups'] as StoreName[]) await done(db.transaction(s, 'readwrite').objectStore(s).clear());
}

/** Asks the browser not to clear Nib-E's storage when space runs low. */
export async function askPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
