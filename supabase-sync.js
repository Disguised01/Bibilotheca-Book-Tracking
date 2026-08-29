/*
 * Bibliotheca — Supabase auth + sync layer
 * ─────────────────────────────────────────────────────────────────────────
 * Loaded by both index.html and reader.html, AFTER the supabase-js CDN
 * script tag and BEFORE each page's own <script> block, so the interception
 * below is in place before the app's load()/save() functions ever run.
 *
 * What this does:
 *  1. Wraps localStorage.setItem so every write to a synced key also stamps
 *     a shadow "<key>__ts" timestamp and schedules a debounced push to
 *     Supabase. The app's existing save() functions don't need to change.
 *  2. On page load, if signed in, pulls each synced key from Supabase and
 *     compares its server timestamp to the local shadow timestamp. If the
 *     server copy is newer (e.g. edited on another device), it overwrites
 *     localStorage and reloads the page once so the app re-parses cleanly.
 *  3. Exposes a tiny magic-link auth UI (sign in / sign out / status) via
 *     BiblioSync.mountAuthWidget(containerEl).
 *
 * Design choice: pull-then-reload rather than live in-place merging. The
 * app's index.html/reader.html read localStorage once at script-parse time
 * into in-memory state; reconciling that live would mean touching render
 * internals on both pages. A single guarded reload is simpler and correct,
 * at the cost of one extra reload the first time newer data is found.
 */

(function (global) {
  // ── Configuration ────────────────────────────────────────────────────
  // Fill these in from your Supabase project settings (Project Settings →
  // API). The anon key is safe to ship client-side — row-level security
  // (see 001_init.sql) is what actually protects the data.
  const SUPABASE_URL = 'https://ewwhbstfgyzmjrmiufaq.supabase.co/';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3d2hic3RmZ3l6bWpybWl1ZmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMTQzODksImV4cCI6MjEwMzU5MDM4OX0.8FdqGpIEt0AVKZnIdMwAB_OL4g55wn8NTPQFfg7lxtA';

  // localStorage key  →  Supabase `library_data.key` value.
  // Every page includes whichever of these keys it actually uses; keys not
  // present in localStorage on a given page are simply skipped.
  const KEY_MAP = {
    'bibliotheca-library-v4': 'library',
    'bibliotheca-active-rack': 'active_rack',
    'bibliotheca-bookmarks': 'bookmarks',
    'bibliotheca-sticky-notes': 'sticky_notes',
    'bibliotheca-reader-mappings': 'reader_mappings',
  };

  const TABLE = 'library_data';
  const PUSH_DEBOUNCE_MS = 1500;
  const RELOAD_GUARD_KEY = 'bibliotheca-sync-reloaded-once';

  let client = null;
  let session = null;
  let statusListeners = [];
  const pushTimers = {};

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
    if (this === localStorage && KEY_MAP[key]) {
      _setItem(key + '__ts', String(Date.now()));
      schedulePush(key);
    }
  };

  function schedulePush(localKey) {
    clearTimeout(pushTimers[localKey]);
    pushTimers[localKey] = setTimeout(() => pushKey(localKey), PUSH_DEBOUNCE_MS);
  }

  async function pushKey(localKey) {
    const sb = getClient();
    if (!sb || !session) return; // not signed in / not configured — local-only, fine
    const remoteKey = KEY_MAP[localKey];
    const value = _getItem(localKey);
    if (value === null) return;
    let parsed;
    try { parsed = JSON.parse(value); } catch (e) { parsed = value; }
    setStatus('syncing');
    const { error } = await sb
      .from(TABLE)
      .upsert({ user_id: session.user.id, key: remoteKey, value: parsed }, { onConflict: 'user_id,key' });
    setStatus(error ? 'error' : 'synced');
    if (error) console.error('[BiblioSync] push failed for', localKey, error);
  }

  // ── Pull + reconcile ─────────────────────────────────────────────────
  async function pullAndReconcile() {
    const sb = getClient();
    if (!sb || !session) return;
    setStatus('syncing');
    const { data: rows, error } = await sb
      .from(TABLE)
      .select('key, value, updated_at')
      .eq('user_id', session.user.id);
    if (error) { setStatus('error'); console.error('[BiblioSync] pull failed', error); return; }

    const reverseMap = Object.fromEntries(Object.entries(KEY_MAP).map(([lk, rk]) => [rk, lk]));
    let appliedNewer = false;

    (rows || []).forEach(row => {
      const localKey = reverseMap[row.key];
      if (!localKey) return;
      const localTs = parseInt(_getItem(localKey + '__ts') || '0', 10);
      const remoteTs = new Date(row.updated_at).getTime();
      const localValueExists = _getItem(localKey) !== null;

      if (!localValueExists || remoteTs > localTs) {
        rawSet(localKey, JSON.stringify(row.value));
        rawSet(localKey + '__ts', String(remoteTs));
        appliedNewer = true;
      }
    });

    setStatus('synced');

    if (appliedNewer && !sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
      global.location.reload();
    }
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
          style="font-family:'Crimson Pro',serif;font-size:12px;padding:5px 8px;background:rgba(0,0,0,0.4);border:1px solid rgba(212,175,55,0.25);border-radius:3px;color:#e0d5c5;width:170px;">
        <button id="bsyncSendLink" class="hbtn" style="padding:6px 14px;font-size:10px;">Sign in</button>
      </span>
      <span id="bsyncSignedIn" style="display:none;">
        <span id="bsyncEmailLabel" style="font-family:'Cinzel',serif;font-size:11px;color:rgba(212,175,55,0.7);margin-right:8px;"></span>
        <button id="bsyncSignOut" class="hbtn" style="padding:6px 14px;font-size:10px;">Sign out</button>
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
  };

  // Auto-init once DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
})(window);
