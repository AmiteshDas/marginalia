// Tiny IndexedDB wrapper for the offline note queue.
// Separate from the synced Supabase table on purpose: a note lives here
// from the moment it's captured until it's confirmed written server-side,
// so a half-finished capture never gets lost if the app closes.

const DB_NAME = "marginalia";
const DB_VERSION = 1;
const STORE = "pending_notes";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "client_id" });
        store.createIndex("queue_status", "queue_status", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueNote(note) {
  const db = await openDB();
  const record = {
    ...note,
    client_id: note.client_id ?? crypto.randomUUID(),
    // Local sync bookkeeping only — distinct from the note's own `status`
    // field (to_read/reading/done), which passes through untouched.
    queue_status: "pending", // pending | synced | failed
    queued_at: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.filter((n) => n.queue_status !== "synced"));
    req.onerror = () => reject(req.error);
  });
}

export async function markSynced(clientId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(clientId);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (record) {
        record.queue_status = "synced";
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function markFailed(clientId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(clientId);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (record) {
        record.queue_status = "failed";
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
