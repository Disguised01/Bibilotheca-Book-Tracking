/*
 * Bibliotheca — Book Source Directory
 * ─────────────────────────────────────────────────────────────────────────
 * Purpose: the app's own 6-digit book id (from generateBookId() in
 * index.html) always stays the primary key for a book, regardless of
 * where its actual file lives. This directory is the lookup table that
 * says, for a given local id, WHICH external catalog it came from and
 * what THAT catalog calls it — so that when the reader wants the actual
 * file bytes, it knows where to fetch them from on demand.
 *
 * This directory does NOT store file content or full catalog metadata —
 * just enough to re-identify the source: { source, externalId, title,
 * author }. Everything else (description, cover image, download links)
 * gets fetched fresh from Gutenberg/Archive each time it's needed, per
 * the "fetched on demand rather than mirrored wholesale" rule.
 *
 * Storage: synced to Supabase under key='book_sources', using the same
 * registry as the library (see supabase-sync.js). The whole directory is
 * already tiny scoped metadata — no stripping needed, just registered
 * as-is. Merge is additive: an entry that exists on this device is never
 * overwritten by a pull (a book's source pairing is fixed at import time
 * and shouldn't change later); entries that arrived from another device
 * get added in. No page reload needed on pull — every lookup here reads
 * localStorage fresh, unlike the library array which is cached in memory.
 *
 * A local book id can point to AT MOST one external source — a book is
 * either "yours" (local upload / your own cloud drive, once that lands)
 * or "public domain" (Gutenberg / Archive), not both at once.
 */

(function (global) {
  const KEY = 'bibliotheca-book-sources';
  const REMOTE_KEY = 'book_sources';

  // 'gutenberg' → Project Gutenberg (numeric ebook id, e.g. 1342 for
  //   Pride and Prejudice — the id Gutendex/gutenberg.org use).
  // 'archive'   → Internet Archive (identifier string, e.g.
  //   "prideandprejudi00aust" — the id used in archive.org/metadata/<id>).
  const VALID_SOURCES = ['gutenberg', 'archive'];

  function loadAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error('[BookSources] failed to read directory', e);
      return {};
    }
  }

  function saveAll(dir) {
    try {
      localStorage.setItem(KEY, JSON.stringify(dir));
    } catch (e) {
      console.error('[BookSources] failed to save directory', e);
    }
  }

  /**
   * Record that local book `bookId` came from an external catalog.
   * entry: { source: 'gutenberg'|'archive', externalId: string,
   *          title: string, author?: string }
   */
  function setSource(bookId, entry) {
    if (!bookId || !/^\d{6}$/.test(bookId)) {
      throw new Error('[BookSources] bookId must be the app\'s 6-digit id');
    }
    if (!entry || !VALID_SOURCES.includes(entry.source)) {
      throw new Error('[BookSources] entry.source must be one of: ' + VALID_SOURCES.join(', '));
    }
    if (!entry.externalId) {
      throw new Error('[BookSources] entry.externalId is required');
    }
    const dir = loadAll();
    dir[bookId] = {
      source: entry.source,
      externalId: String(entry.externalId),
      title: entry.title || '',
      author: entry.author || '',
      addedAt: dir[bookId] && dir[bookId].addedAt ? dir[bookId].addedAt : new Date().toISOString(),
    };
    saveAll(dir);
    return dir[bookId];
  }

  /** Look up the external source for a local book id, or null if it's not from one. */
  function getSource(bookId) {
    const dir = loadAll();
    return dir[bookId] || null;
  }

  /** Remove the mapping (e.g. book deleted from the library, or converted to a local upload). */
  function removeSource(bookId) {
    const dir = loadAll();
    if (dir[bookId]) {
      delete dir[bookId];
      saveAll(dir);
      return true;
    }
    return false;
  }

  /** True if this book id is backed by an external catalog rather than a local/cloud file. */
  function hasSource(bookId) {
    return !!getSource(bookId);
  }

  /** All directory entries, as an array of { bookId, source, externalId, title, author, addedAt }. */
  function listAll() {
    const dir = loadAll();
    return Object.keys(dir).map(bookId => ({ bookId, ...dir[bookId] }));
  }

  /** All entries for one source ('gutenberg' or 'archive'). */
  function listBySource(source) {
    return listAll().filter(e => e.source === source);
  }

  /** Reverse lookup: find the local book id already assigned to a given external id, if any — avoids duplicate imports. */
  function findByExternalId(source, externalId) {
    const match = listAll().find(e => e.source === source && e.externalId === String(externalId));
    return match ? match.bookId : null;
  }

  global.BookSources = {
    setSource,
    getSource,
    removeSource,
    hasSource,
    listAll,
    listBySource,
    findByExternalId,
  };

  // ── Sync registration ────────────────────────────────────────────────
  // Additive merge: keep every local entry as-is (a pairing, once made,
  // doesn't change), and add in any entry that only exists remotely
  // (e.g. imported on another device). If the same bookId somehow exists
  // on both sides with different values, the local copy wins — this
  // directory is small and additive by nature, so that's the safe default.
  function mergeBookSources(remoteDir, currentLocalDir) {
    const local = currentLocalDir && typeof currentLocalDir === 'object' ? currentLocalDir : {};
    const remote = remoteDir && typeof remoteDir === 'object' ? remoteDir : {};
    const merged = { ...local };
    Object.keys(remote).forEach(bookId => {
      if (!merged[bookId]) merged[bookId] = remote[bookId];
    });
    return merged;
  }

  if (global.BiblioSync && global.BiblioSync.registerSyncTarget) {
    global.BiblioSync.registerSyncTarget({
      localKey: KEY,
      remoteKey: REMOTE_KEY,
      strip: v => v, // already minimal — nothing to strip
      merge: mergeBookSources,
      reloadOnChange: false, // loadAll() re-reads localStorage every call
    });
  } else {
    console.warn('[BookSources] BiblioSync not found — load supabase-sync.js before book-sources.js to enable syncing.');
  }
})(window);
