// Admin training session for after-photo → category sorting (Gemini few-shot).

import { toast, loadMe, signOut } from '/shared.js';

const API = '/api/central-pet';

async function apiCall(path, opts = {}) {
  const res = await window.cpAuthFetch(`${API}${path}`, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let state = null;

async function load() {
  state = await apiCall('/shift-day/photo-ai/training');
  render();
}

function render() {
  const readiness = state.readiness || {};
  const counts = state.counts || {};
  const cats = state.categories || [];
  const examples = state.examples || [];

  $('trainStatus').innerHTML = `
    <div class="train-stat"><strong>${state.classifyEnabled ? 'ON' : 'OFF'}</strong><span>Gemini classify</span></div>
    <div class="train-stat"><strong>${escapeHtml(state.model || '—')}</strong><span>Model</span></div>
    <div class="train-stat"><strong>${examples.length}</strong><span>Total examples</span></div>
    <div class="train-stat"><strong>${readiness.ready ? 'Ready' : 'Needs more'}</strong><span>Corpus status</span></div>
  `;
  $('trainMessage').textContent = readiness.message || state.envHint || '';

  const byCat = new Map(cats.map((c) => [c.id, []]));
  for (const ex of examples) {
    if (!byCat.has(ex.categoryId)) byCat.set(ex.categoryId, []);
    byCat.get(ex.categoryId).push(ex);
  }

  const min = readiness.minUsefulPerCategory || 3;
  const recommended = readiness.recommendedPerCategory || 5;

  $('trainCats').innerHTML = cats
    .map((cat) => {
      const have = counts[cat.id] || 0;
      const list = byCat.get(cat.id) || [];
      const cls = have >= min ? 'ready' : 'short';
      return `
        <section class="train-cat ${cls}" data-cat="${escapeHtml(cat.id)}">
          <h2>${escapeHtml(cat.label)}</h2>
          <div class="count">${have} / ${min} minimum · aim for ${recommended} · id <code>${escapeHtml(cat.id)}</code></div>
          <form class="train-upload" data-upload="${escapeHtml(cat.id)}">
            <label class="field">Photo
              <input type="file" accept="image/*" required>
            </label>
            <label class="field">Note (optional)
              <input type="text" name="notes" maxlength="500" placeholder="e.g. full endcap, store 53">
            </label>
            <button type="submit" class="primary">Add example</button>
          </form>
          <div class="train-grid">
            ${list
              .map(
                (ex) => `
              <div class="train-thumb" data-id="${escapeHtml(ex.id)}">
                <img alt="" data-example-id="${escapeHtml(ex.id)}" />
                <button type="button" class="subtle" data-del="${escapeHtml(ex.id)}">Delete</button>
              </div>`
              )
              .join('') || '<p class="overlay-meta">No examples yet — upload your first.</p>'}
          </div>
        </section>`;
    })
    .join('');

  // Auth'd image load (bare <img src> cannot send session JWT)
  $('trainCats').querySelectorAll('img[data-example-id]').forEach(async (img) => {
    const id = img.getAttribute('data-example-id');
    try {
      const res = await window.cpAuthFetch(
        `${API}/shift-day/photo-ai/training/${encodeURIComponent(id)}/file`
      );
      if (!res.ok) return;
      const blob = await res.blob();
      img.src = URL.createObjectURL(blob);
    } catch {
      /* ignore */
    }
  });

  $('trainCats').querySelectorAll('form[data-upload]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const categoryId = form.getAttribute('data-upload');
      const file = form.querySelector('input[type=file]')?.files?.[0];
      const notes = form.querySelector('input[name=notes]')?.value || '';
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('categoryId', categoryId);
      fd.append('notes', notes);
      try {
        await apiCall('/shift-day/photo-ai/training', { method: 'POST', body: fd });
        toast(`Added ${categoryId} example`, 'ok', 2000);
        await load();
      } catch (err) {
        toast(err.message || 'Upload failed', 'bad', 4000);
      }
    });
  });

  $('trainCats').querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-del');
      if (!confirm('Delete this training example?')) return;
      try {
        await apiCall(`/shift-day/photo-ai/training/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Deleted', 'ok', 1600);
        await load();
      } catch (err) {
        toast(err.message || 'Delete failed', 'bad', 4000);
      }
    });
  });
}

async function boot() {
  try {
    await window.cpAuth?.bootPromise;
  } catch {
    /* auth-gate redirects on failure */
  }

  let me;
  try {
    me = await loadMe();
  } catch (err) {
    $('trainMessage').textContent = err.message || 'Sign in required';
    return;
  }

  $('userBar')?.removeAttribute('hidden');
  $('btnSignOut')?.addEventListener('click', () => signOut());

  if (me.layer !== 'admin' && !me.isAdmin) {
    $('trainMessage').textContent = 'Admin only — open Planning Desk with an admin account.';
    return;
  }

  try {
    await load();
  } catch (err) {
    $('trainMessage').textContent = err.message || 'Failed to load training corpus';
  }
}

boot();
