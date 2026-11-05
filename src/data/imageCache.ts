/**
 * Cópia local das fotos (IndexedDB do navegador).
 *
 * Cada foto tem como id o SHA-256 do próprio conteúdo: o mesmo id é sempre a mesma foto, então
 * ela pode ficar guardada no navegador para sempre. Ao entrar no sistema, só as fotos que este
 * navegador ainda não tem são buscadas no banco (antes, todas eram baixadas a cada login).
 * Se o navegador não permitir (modo anônimo, armazenamento cheio), tudo segue funcionando sem cache.
 */
const DB_NAME = 'ideia-cubica-fotos';
const STORE = 'fotos';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function cachedImages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const db = await open();
  if (!db || !ids.length) return out;
  await new Promise<void>((resolve) => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      let left = ids.length;
      for (const id of ids) {
        const r = store.get(id);
        r.onsuccess = () => { if (typeof r.result === 'string') out.set(id, r.result); if (--left === 0) resolve(); };
        r.onerror = () => { if (--left === 0) resolve(); };
      }
    } catch { resolve(); }
  });
  db.close();
  return out;
}

export async function rememberImages(images: Map<string, string>): Promise<void> {
  if (!images.size) return;
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      for (const [id, data] of images) tx.objectStore(STORE).put(data, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
  db.close();
}
