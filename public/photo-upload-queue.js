/**
 * Non-blocking photo upload queue for Shift Day capture.
 * Capture returns immediately; uploads run in the background with limited concurrency.
 * Pure logic — no DOM. Used by visit-flow-ui.js.
 */

let _idSeq = 0;

export function createPhotoUploadQueue({
  maxConcurrent = 2,
  uploadFn,
  onChange = () => {},
} = {}) {
  if (typeof uploadFn !== 'function') {
    throw new Error('createPhotoUploadQueue requires uploadFn(item) => Promise');
  }

  const items = [];
  let active = 0;
  let closed = false;

  function emit() {
    onChange(snapshot());
  }

  function snapshot() {
    const queued = items.filter((i) => i.status === 'queued').length;
    const uploading = items.filter((i) => i.status === 'uploading').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const done = items.filter((i) => i.status === 'done').length;
    return {
      items: items.map((i) => ({ ...i })),
      queued,
      uploading,
      failed,
      done,
      inFlight: queued + uploading,
      busy: queued + uploading > 0,
    };
  }

  function matchesExtra(item, extra) {
    const a = item.extra || {};
    const b = extra || {};
    return (
      a.target === b.target &&
      String(a.categoryId || '') === String(b.categoryId || '') &&
      String(a.itemId || '') === String(b.itemId || '') &&
      String(a.status || '') === String(b.status || '')
    );
  }

  function pendingFor(extra) {
    return items.filter(
      (i) => (i.status === 'queued' || i.status === 'uploading' || i.status === 'failed') && matchesExtra(i, extra)
    );
  }

  function pump() {
    if (closed) return;
    while (active < maxConcurrent) {
      const next = items.find((i) => i.status === 'queued');
      if (!next) break;
      active += 1;
      next.status = 'uploading';
      next.startedAt = Date.now();
      emit();
      Promise.resolve()
        .then(() => uploadFn(next))
        .then((result) => {
          next.status = 'done';
          next.result = result;
          next.error = null;
          next.finishedAt = Date.now();
        })
        .catch((err) => {
          next.status = 'failed';
          next.error = err?.message || String(err);
          next.finishedAt = Date.now();
        })
        .finally(() => {
          active -= 1;
          emit();
          pump();
        });
    }
  }

  /**
   * Enqueue a captured file. Returns the queue item immediately (does not wait for upload).
   */
  function enqueue(file, extra = {}) {
    if (closed) throw new Error('Photo queue is closed');
    if (!file) throw new Error('file required');
    const item = {
      id: `pq-${Date.now()}-${++_idSeq}`,
      file,
      extra: { ...extra },
      status: 'queued',
      error: null,
      result: null,
      previewUrl:
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function' &&
        (typeof Blob !== 'undefined' && file instanceof Blob)
          ? URL.createObjectURL(file)
          : null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    items.push(item);
    emit();
    pump();
    return item;
  }

  function retry(id) {
    const item = items.find((i) => i.id === id);
    if (!item || item.status !== 'failed') return false;
    item.status = 'queued';
    item.error = null;
    item.startedAt = null;
    item.finishedAt = null;
    emit();
    pump();
    return true;
  }

  function remove(id) {
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const [item] = items.splice(idx, 1);
    if (item.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        /* ignore */
      }
    }
    emit();
    return true;
  }

  /** Drop completed items (keep failed until retry/dismiss). */
  function pruneDone() {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].status !== 'done') continue;
      const [item] = items.splice(i, 1);
      if (item.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          /* ignore */
        }
      }
    }
    emit();
  }

  function close() {
    closed = true;
  }

  return {
    enqueue,
    retry,
    remove,
    pendingFor,
    pruneDone,
    snapshot,
    close,
    get items() {
      return items;
    },
  };
}
