/**
 * IndexedDB offline safety net for visit photos (and optional draft patches).
 * Photos are written here before network upload so a refresh can't lose them.
 */

const DB_NAME = 'cp_offline_v1';
const DB_VERSION = 1;
const STORE_PHOTOS = 'photos';
const STORE_PATCHES = 'patches';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        const s = db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
        s.createIndex('byVisit', 'visitKey', { unique: false });
        s.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PATCHES)) {
        const s = db.createObjectStore(STORE_PATCHES, { keyPath: 'id' });
        s.createIndex('byVisit', 'visitKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB open failed'));
  });
}

function visitKey(repKey, date, actualStore) {
  return `${repKey}|${date}|${actualStore}`;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
  });
}

/**
 * Persist a photo blob before upload.
 * @param {{ id: string, repKey: string, date: string, actualStore: number|string, extra: object, file: Blob|File, previewUrl?: string|null }} rec
 */
export async function putPendingPhoto(rec) {
  const db = await openDb();
  const row = {
    id: rec.id,
    visitKey: visitKey(rec.repKey, rec.date, rec.actualStore),
    repKey: rec.repKey,
    date: rec.date,
    actualStore: Number(rec.actualStore),
    extra: rec.extra || {},
    file: rec.file,
    fileName: rec.file?.name || 'photo.jpg',
    fileType: rec.file?.type || 'image/jpeg',
    status: 'pending',
    error: null,
    createdAt: Date.now(),
  };
  const tx = db.transaction(STORE_PHOTOS, 'readwrite');
  tx.objectStore(STORE_PHOTOS).put(row);
  await txDone(tx);
  db.close();
  return row;
}

export async function markPhotoDone(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_PHOTOS, 'readwrite');
  const store = tx.objectStore(STORE_PHOTOS);
  const getReq = store.get(id);
  await new Promise((resolve, reject) => {
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (row) store.delete(id);
      resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
  await txDone(tx);
  db.close();
}

export async function markPhotoFailed(id, error) {
  const db = await openDb();
  const tx = db.transaction(STORE_PHOTOS, 'readwrite');
  const store = tx.objectStore(STORE_PHOTOS);
  const getReq = store.get(id);
  await new Promise((resolve, reject) => {
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (row) {
        row.status = 'failed';
        row.error = error || 'upload failed';
        store.put(row);
      }
      resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
  await txDone(tx);
  db.close();
}

export async function listPendingPhotos(forVisit = null) {
  const db = await openDb();
  const tx = db.transaction(STORE_PHOTOS, 'readonly');
  const store = tx.objectStore(STORE_PHOTOS);
  const req = store.getAll();
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  if (!forVisit) return rows;
  const vk = visitKey(forVisit.repKey, forVisit.date, forVisit.actualStore);
  return rows.filter((r) => r.visitKey === vk);
}

export async function countPendingPhotos() {
  const rows = await listPendingPhotos();
  return rows.length;
}

export async function putDraftPatch(rec) {
  const db = await openDb();
  const row = {
    id: rec.id || `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    visitKey: visitKey(rec.repKey, rec.date, rec.actualStore),
    repKey: rec.repKey,
    date: rec.date,
    actualStore: Number(rec.actualStore),
    path: rec.path,
    body: rec.body,
    createdAt: Date.now(),
  };
  const tx = db.transaction(STORE_PATCHES, 'readwrite');
  tx.objectStore(STORE_PATCHES).put(row);
  await txDone(tx);
  db.close();
  return row;
}

export async function deleteDraftPatch(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_PATCHES, 'readwrite');
  tx.objectStore(STORE_PATCHES).delete(id);
  await txDone(tx);
  db.close();
}

export async function listDraftPatches(forVisit = null) {
  const db = await openDb();
  const tx = db.transaction(STORE_PATCHES, 'readonly');
  const req = tx.objectStore(STORE_PATCHES).getAll();
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  if (!forVisit) return rows;
  const vk = visitKey(forVisit.repKey, forVisit.date, forVisit.actualStore);
  return rows.filter((r) => r.visitKey === vk);
}

export { visitKey };
