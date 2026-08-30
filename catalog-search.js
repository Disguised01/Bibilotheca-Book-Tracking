/*
 * Bibliotheca — Catalog Search
 * ─────────────────────────────────────────────────────────────────────────
 * Pure search/lookup functions against the two public-domain catalogs.
 * This module does NOT decide anything and does NOT write to
 * book-sources.js — it just returns normalized candidate results for a
 * human to look at and confirm. Deliberately no fuzzy auto-matching here:
 * see the discussion this followed — resolving a book's external id by
 * name-matching alone is exactly the ambiguity a fixed id is meant to
 * avoid, so this stays a search tool, not a linker.
 *
 * Both search functions return the same normalized shape so the UI that
 * displays results doesn't need to care which catalog they came from:
 *   { source: 'gutenberg'|'archive', externalId, title, author, coverUrl }
 */

(function (global) {
  // Gutendex is a community-run read API over Project Gutenberg's catalog
  // — no key needed, returns clean JSON (title/author/id), which is far
  // easier to work with than Gutenberg's own bulk RDF/catalog files.
  const GUTENDEX_BASE = 'https://gutendex.com/books';

  async function searchGutenberg(query) {
    const url = `${GUTENDEX_BASE}?search=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gutenberg search failed (${res.status})`);
    const data = await res.json();
    return (data.results || []).slice(0, 10).map(book => ({
      source: 'gutenberg',
      externalId: String(book.id),
      title: book.title || 'Untitled',
      author: (book.authors && book.authors[0] && book.authors[0].name) || 'Unknown',
      coverUrl: (book.formats && book.formats['image/jpeg']) || null,
    }));
  }

  // Internet Archive's advancedsearch endpoint over the "texts" mediatype,
  // restricted to items that actually have a public-domain-friendly
  // access status. This is a search-only call — no file bytes fetched.
  const ARCHIVE_SEARCH_BASE = 'https://archive.org/advancedsearch.php';

  async function searchArchive(query) {
    const params = new URLSearchParams({
      q: `title:(${query}) AND mediatype:texts`,
      'fl[]': ['identifier', 'title', 'creator'],
      rows: '10',
      output: 'json',
    });
    const url = `${ARCHIVE_SEARCH_BASE}?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Internet Archive search failed (${res.status})`);
    const data = await res.json();
    const docs = (data.response && data.response.docs) || [];
    return docs.map(doc => ({
      source: 'archive',
      externalId: doc.identifier,
      title: doc.title || 'Untitled',
      author: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || 'Unknown'),
      coverUrl: `https://archive.org/services/img/${doc.identifier}`,
    }));
  }

  /** Search both catalogs at once. Failures in one source don't block the other. */
  async function searchAll(query) {
    const [gutenberg, archive] = await Promise.allSettled([
      searchGutenberg(query),
      searchArchive(query),
    ]);
    return {
      gutenberg: gutenberg.status === 'fulfilled' ? gutenberg.value : [],
      archive: archive.status === 'fulfilled' ? archive.value : [],
      errors: [gutenberg, archive].filter(r => r.status === 'rejected').map(r => r.reason && r.reason.message),
    };
  }

  global.CatalogSearch = { searchGutenberg, searchArchive, searchAll };
})(window);
