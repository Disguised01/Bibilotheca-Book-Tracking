/*
 * Bibliotheca — Supabase auth + sync layer
 * ─────────────────────────────────────────────────────────────────────────
 * Loaded by both index.html and reader.html, AFTER the supabase-js CDN
 * script tag and BEFORE any module that wants to sync a localStorage key
 * (book-sources.js, and each page's own <script> block).
 *
 * SYNC MODEL: a registry, not a hardcoded key list.
 * Any module can call BiblioSync.registerSyncTarget({...}) to have one of
 * its localStorage keys synced to Supabase, each with its own rules for
 * what actually gets uploaded and how a pull gets merged back in. Two
 * targets are registered today:
 *   - library (registered below)      — rack/shelf/book structure only
 *   - book_sources (in book-sources.js) — the Gutenberg/Archive id pairing
 * Neither module needs to know about the other, or about the mechanics of
 * pushing/pulling — they just describe their own strip/merge rules.
 *
 * registerSyncTarget({
 *   localKey,       // the localStorage key to watch, e.g. 'bibliotheca-library-v4'
 *   remoteKey,      // the `library_data.key` value to store it under
 *   strip(fullLocalValue) -> value to upload (keep payloads small/scoped)
 *   merge(remoteValue, currentFullLocalValue) -> value to write back locally
 *   reloadOnChange, // true if the host page caches this data in memory at
 *                   // parse time and needs a reload to see a pulled update
 *                   // (true for library; false for book-sources, which
 *                   // re-reads localStorage on every call)
 * })
 *
 * What this does, mechanically:
 *  1. Wraps localStorage.setItem — a write to any registered key stamps a
 *     shadow "<key>__ts" timestamp and schedules a debounced push of that
 *     key's stripped value.
 *  2. On sign-in (and whenever a new target registers while already
 *     signed in), pulls every registered key from Supabase and merges it
 *     into the corresponding localStorage key via that target's merge().
 *  3. Exposes a tiny magic-link auth UI via BiblioSync.mountAuthWidget().
 */

(function (global) {
  // ── Configuration ────────────────────────────────────────────────────
  // Fill these in from your Supabase project settings (Project Settings →
  // API). The anon key is safe to ship client-side — row-level security
  // (see 001_init.sql) is what actually protects the data.
  const SUPABASE_URL = 'https://ewwhbstfgyzmjrmiufaq.supabase.co/';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2hic3RmZ3l6bWpybWl1ZmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMTQzODksImV4cCI6MjEwMzU5MDM4OX0.8FdqGpIEt0AVKZnIdMwAB_OL4g55wn8NTPQFfg7lxtA';

  const TABLE = 'library_data';
  const PUSH_DEBOUNCE_MS = 1500;
  const RELOAD_GUARD_KEY = 'bibliotheca-sync-reloaded-once';

  let client = null;
  let session = null;
  let statusListeners = [];
  const pushTimers = {};
  const targets = {}; // localKey -> { remoteKey, strip, merge, reloadOnChange }

  // ── Client bootstrap ─────────────────────────────────────────────────
  function getClient() {
    if (client) return client;
    if (!global.supabase || !global.supabase.createClient) {
      console.warn('[BiblioSync] supabase-js not loaded yet.');
      return null;
    }
    if (SUPABASE_URL.startsWith('YOUR_')) {
      console.warn('[BiblioSync] Supabase URL/key not configured — sync disabled.');
      return null;
    }
    client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  }

  function setStatus(status) {
    statusListeners.forEach(fn => { try { fn(status); } catch (e) {} });
  }

  // ── localStorage interception ────────────────────────────────────────
  const _setItem = Storage.prototype.setItem.bind(localStorage);
  const _getItem = Storage.prototype.getItem.bind(localStorage);

  function rawSet(key, value) { _setItem(key, value); }

  Storage.prototype.setItem = function (key, value) {
    _setItem(key, value);
    if (this === localStorage && targets[key]) {
      _setItem(key + '__ts', String(Date.now()));
      schedulePush(key);
    }
  };

  function schedulePush(localKey) {
    clearTimeout(pushTimers[localKey]);
    pushTimers[localKey] = setTimeout(() => pushTarget(localKey), PUSH_DEBOUNCE_MS);
  }

  async function pushTarget(localKey) {
    const sb = getClient();
    const target = targets[localKey];
    if (!sb || !session || !target) return; // not signed in / not configured — local-only, fine
    const raw = _getItem(localKey);
    if (raw === null) return;
    let fullValue;
    try { fullValue = JSON.parse(raw); } catch (e) { return; }
    const stripped = target.strip ? target.strip(fullValue) : fullValue;
    setStatus('syncing');
    const { error } = await sb
      .from(TABLE)
      .upsert({ user_id: session.user.id, key: target.remoteKey, value: stripped }, { onConflict: 'user_id,key' });
    setStatus(error ? 'error' : 'synced');
    if (error) console.error('[BiblioSync] push failed for', localKey, error);
  }

  // ── Pull + reconcile ─────────────────────────────────────────────────
  async function pullAndReconcile() {
    const sb = getClient();
    if (!sb || !session) return;
    const localKeys = Object.keys(targets);
    if (!localKeys.length) return;
    const remoteKeys = localKeys.map(lk => targets[lk].remoteKey);

    setStatus('syncing');
    const { data: rows, error } = await sb
      .from(TABLE)
      .select('key, value, updated_at')
      .eq('user_id', session.user.id)
      .in('key', remoteKeys);
    if (error) { setStatus('error'); console.error('[BiblioSync] pull failed', error); return; }
    setStatus('synced');

    const reverseMap = Object.fromEntries(localKeys.map(lk => [targets[lk].remoteKey, lk]));
    let needsReload = false;

    (rows || []).forEach(row => {
      const localKey = reverseMap[row.key];
      const target = targets[localKey];
      if (!target) return;

      const localTs = parseInt(_getItem(localKey + '__ts') || '0', 10);
      const remoteTs = new Date(row.updated_at).getTime();
      const localValueExists = _getItem(localKey) !== null;

      if (!localValueExists || remoteTs > localTs) {
        const currentFull = (() => {
          try { return JSON.parse(_getItem(localKey) || 'null'); } catch (e) { return null; }
        })();
        const merged = target.merge ? target.merge(row.value, currentFull) : row.value;
        rawSet(localKey, JSON.stringify(merged));
        rawSet(localKey + '__ts', String(remoteTs));
        if (target.reloadOnChange) needsReload = true;
      }
    });

    if (needsReload && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
      global.location.reload();
    }
  }

  /** Register a localStorage key to be synced. See header comment for shape. */
  function registerSyncTarget(cfg) {
    if (!cfg || !cfg.localKey || !cfg.remoteKey) {
      throw new Error('[BiblioSync] registerSyncTarget needs localKey and remoteKey');
    }
    targets[cfg.localKey] = cfg;
    // If we're already signed in when this registers (e.g. book-sources.js
    // loading after auth already resolved), pull this target in immediately
    // rather than waiting for the next sign-in event.
    if (session) pullAndReconcile();
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  async function initAuth() {
    const sb = getClient();
    if (!sb) return;

    const { data } = await sb.auth.getSession();
    session = data.session;
    setStatus(session ? 'signed-in' : 'signed-out');
    if (session) await pullAndReconcile();

    sb.auth.onAuthStateChange(async (event, newSession) => {
      session = newSession;
      if (event === 'SIGNED_IN') {
        setStatus('signed-in');
        sessionStorage.removeItem(RELOAD_GUARD_KEY);
        await pullAndReconcile();
      } else if (event === 'SIGNED_OUT') {
        setStatus('signed-out');
      }
    });
  }

  async function signInWithMagicLink(email) {
    const sb = getClient();
    if (!sb) throw new Error('Sync not configured');
    return sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: global.location.href },
    });
  }

  async function signOut() {
    const sb = getClient();
    if (!sb) return;
    await sb.auth.signOut();
  }

  // ── Minimal auth widget (email input + status pill) ─────────────────
  function mountAuthWidget(container) {
    if (!container) return;
    container.innerHTML = `
      <span id="bsyncStatus" style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:rgba(212,175,55,0.45);"></span>
      <span id="bsyncSignedOut">
        <input id="bsyncEmail" type="email" placeholder="you@example.com"
          style="font-family:'Crimson Pro',serif;font-size:12px;padding:7px 9px;background:rgba(0,0,0,0.4);border:1px solid rgba(212,175,55,0.25);border-radius:3px;color:#e0d5c5;">
        <button id="bsyncSendLink" class="hbtn" style="padding:7px 14px;font-size:10px;">Sign in</button>
      </span>
      <span id="bsyncSignedIn" style="display:none;">
        <span id="bsyncEmailLabel" style="font-family:'Cinzel',serif;font-size:11px;color:rgba(212,175,55,0.7);"></span>
        <button id="bsyncSignOut" class="hbtn" style="padding:7px 14px;font-size:10px;">Sign out</button>
      </span>
    `;

    const statusEl = container.querySelector('#bsyncStatus');
    const outEl = container.querySelector('#bsyncSignedOut');
    const inEl = container.querySelector('#bsyncSignedIn');
    const emailLabel = container.querySelector('#bsyncEmailLabel');

    const STATUS_TEXT = {
      'signed-out': 'Local only',
      'signed-in': 'Signed in',
      syncing: 'Syncing…',
      synced: 'Synced',
      error: 'Sync error',
    };

    onStatus(status => {
      statusEl.textContent = STATUS_TEXT[status] || '';
      if (status === 'signed-in' || status === 'syncing' || status === 'synced') {
        outEl.style.display = 'none';
        inEl.style.display = 'inline';
        if (session && session.user) emailLabel.textContent = session.user.email;
      } else if (status === 'signed-out') {
        outEl.style.display = 'inline';
        inEl.style.display = 'none';
      }
    });

    container.querySelector('#bsyncSendLink').addEventListener('click', async () => {
      const email = container.querySelector('#bsyncEmail').value.trim();
      if (!email) return;
      try {
        await signInWithMagicLink(email);
        alert('Check your email for a sign-in link.');
      } catch (e) {
        alert('Could not send sign-in link: ' + e.message);
      }
    });

    container.querySelector('#bsyncSignOut').addEventListener('click', async () => {
      await signOut();
    });
  }

  function onStatus(fn) {
    statusListeners.push(fn);
    fn(session ? 'signed-in' : 'signed-out');
  }

  // ── Public API ────────────────────────────────────────────────────────
  global.BiblioSync = {
    init: initAuth,
    signInWithMagicLink,
    signOut,
    mountAuthWidget,
    onStatus,
    registerSyncTarget,
    getSession: () => session,
  };

  // ── Library sync target (structure only — see header comment) ───────
  // Full local shape: [{ title, theme, label, shelves: [{ title, desc,
  //   color, books: [{ id, author, title, note, done, pagesRead,
  //   pagesTotal, startDate, completionDate, color }] }] }]
  // Stripped remote shape: only what's listed below.
  function stripLibrary(fullData) {
    if (!Array.isArray(fullData)) return [];
    return fullData.map(rack => ({
      title: rack.title || 'Untitled',
      theme: rack.theme || 'philosophy',
      shelves: (rack.shelves || []).map(shelf => ({
        title: shelf.title || 'Shelf',
        books: (shelf.books || []).map(b => ({
          id: b.id, title: b.title, author: b.author, done: !!b.done,
        })),
      })),
    }));
  }

  // Merge a stripped remote structure into the current full local library.
  // Existing books (matched by id) keep every local-only field; only
  // title/author/done are refreshed from remote. New books arrive with
  // just the synced fields — notes/progress start empty on this device
  // until the person adds them here, which is expected for unsynced data.
  function mergeLibrary(remoteStripped, currentFullLocal) {
    const localFull = Array.isArray(currentFullLocal) ? currentFullLocal : [];
    const localBooksById = {};
    localFull.forEach(rack => (rack.shelves || []).forEach(shelf =>
      (shelf.books || []).forEach(b => { if (b.id) localBooksById[b.id] = b; })
    ));

    return (remoteStripped || []).map(rack => ({
      title: rack.title,
      theme: rack.theme,
      shelves: (rack.shelves || []).map(shelf => ({
        title: shelf.title,
        books: (shelf.books || []).map(rb => {
          const existing = localBooksById[rb.id];
          if (existing) {
            return { ...existing, title: rb.title, author: rb.author, done: rb.done };
          }
          return { id: rb.id, title: rb.title, author: rb.author, done: rb.done, note: '' };
        }),
      })),
    }));
  }

  registerSyncTarget({
    localKey: 'bibliotheca-library-v4',
    remoteKey: 'library',
    strip: stripLibrary,
    merge: mergeLibrary,
    reloadOnChange: true, // index.html/reader.html cache `data` in memory at parse time
  });

  // Auto-init once DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
})(window);