'use strict';

/**
 * Smoke tests for public/photo-upload-queue.js (ESM) via dynamic import.
 * Does not start a browser or hit the network.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let createPhotoUploadQueue;

before(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, '../public/photo-upload-queue.js')).href
  );
  createPhotoUploadQueue = mod.createPhotoUploadQueue;
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('photo-upload-queue', () => {
  it('enqueue returns immediately and does not await upload', async () => {
    let started = 0;
    let resolveUpload;
    const uploadFn = () =>
      new Promise((resolve) => {
        started += 1;
        resolveUpload = resolve;
      });

    const q = createPhotoUploadQueue({ maxConcurrent: 1, uploadFn });
    const t0 = Date.now();
    const item = q.enqueue({ name: 'a.jpg' }, { target: 'before' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 50, 'enqueue must not wait for upload');
    // pump schedules upload on microtask — status is uploading before uploadFn runs
    assert.equal(item.status, 'uploading');
    await delay(0);
    assert.equal(started, 1);
    assert.equal(q.snapshot().inFlight, 1);

    resolveUpload({ ok: true });
    await delay(20);
    assert.equal(q.snapshot().done, 1);
    assert.equal(q.snapshot().inFlight, 0);
  });

  it('queues many captures while one upload runs (burst-friendly)', async () => {
    const resolvers = [];
    const uploadFn = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });

    const q = createPhotoUploadQueue({ maxConcurrent: 1, uploadFn });
    for (let i = 0; i < 8; i++) {
      q.enqueue({ name: `p${i}.jpg` }, { target: 'before' });
    }
    await delay(0);
    const snap = q.snapshot();
    assert.equal(snap.items.length, 8);
    assert.equal(snap.uploading, 1);
    assert.equal(snap.queued, 7);

    // drain all 8 (each completion starts the next)
    for (let i = 0; i < 8; i++) {
      await delay(0);
      assert.ok(resolvers.length >= 1, `expected a pending upload at step ${i}`);
      resolvers.shift()({ ok: true });
      await delay(10);
    }
    await delay(30);
    assert.equal(q.snapshot().done, 8);
    assert.equal(q.snapshot().inFlight, 0);
  });

  it('pendingFor filters by target/category', async () => {
    const q = createPhotoUploadQueue({
      maxConcurrent: 1,
      uploadFn: async () => {
        await delay(50);
        return {};
      },
    });
    q.enqueue({ name: 'a.jpg' }, { target: 'before' });
    q.enqueue({ name: 'b.jpg' }, { target: 'category', categoryId: 'endcaps' });
    assert.equal(q.pendingFor({ target: 'before' }).length, 1);
    assert.equal(q.pendingFor({ target: 'category', categoryId: 'endcaps' }).length, 1);
    assert.equal(q.pendingFor({ target: 'after' }).length, 0);
  });

  it('failure marks item failed; retry re-queues', async () => {
    let n = 0;
    const q = createPhotoUploadQueue({
      maxConcurrent: 1,
      uploadFn: async () => {
        n += 1;
        if (n === 1) throw new Error('network down');
        return { ok: true };
      },
    });
    const item = q.enqueue({ name: 'x.jpg' }, { target: 'before' });
    await delay(30);
    assert.equal(item.status, 'failed');
    assert.match(item.error, /network down/);
    assert.equal(q.snapshot().failed, 1);

    q.retry(item.id);
    await delay(30);
    assert.equal(item.status, 'done');
    assert.equal(q.snapshot().failed, 0);
    assert.equal(n, 2);
  });

  it('maxConcurrent limits parallel uploads', async () => {
    let concurrent = 0;
    let maxSeen = 0;
    const resolvers = [];
    const q = createPhotoUploadQueue({
      maxConcurrent: 2,
      uploadFn: () =>
        new Promise((resolve) => {
          concurrent += 1;
          maxSeen = Math.max(maxSeen, concurrent);
          resolvers.push(() => {
            concurrent -= 1;
            resolve({});
          });
        }),
    });
    for (let i = 0; i < 5; i++) q.enqueue({ name: `${i}.jpg` }, { target: 'before' });
    await delay(10);
    assert.equal(maxSeen, 2);
    assert.equal(q.snapshot().uploading, 2);
    assert.equal(q.snapshot().queued, 3);
    while (resolvers.length) {
      resolvers.shift()();
      await delay(5);
    }
    await delay(20);
    assert.equal(q.snapshot().done, 5);
  });
});
