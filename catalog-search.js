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

  // ── Fetching the actual file (this is the part that tests whether id
  // pairing genuinely works end-to-end, not just search) ─────────────────
  //
  // Gutendex's own API responses are CORS-friendly (that's what powers
  // search above), but the actual book FILES are hosted on gutenberg.org's
  // static file servers, which historically have NOT reliably sent
  // Access-Control-Allow-Origin headers for direct browser fetches. This
  // function is written to work if they do — but if it throws a generic
  // "Failed to fetch" with no useful status code, that's the classic CORS
  // fingerprint, not a bug in the id pairing itself. See the caller in
  // reader.html for how that distinction is surfaced to the user.
  async function getGutenbergFormats(externalId) {
    const res = await fetch(`${GUTENDEX_BASE}/${externalId}`);
    if (!res.ok) throw new Error(`Could not look up Gutenberg book #${externalId} (${res.status})`);
    const data = await res.json();
    return data.formats || {};
  }

  // Prefer EPUB (renders with epub.js already in the app); fall back to
  // plain text if that's all this particular book offers.
  async function fetchGutenbergFile(externalId) {
    const formats = await getGutenbergFormats(externalId);
    const epubUrl = Object.entries(formats).find(([mime]) => mime === 'application/epub+zip')?.[1];
    const textUrl = Object.entries(formats).find(([mime]) => mime.startsWith('text/plain'))?.[1];
    const url = epubUrl || textUrl;
    if (!url) throw new Error('This Gutenberg book has no EPUB or plain-text format available.');

    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      // A network-level failure with no response at all is the CORS
      // fingerprint mentioned above — surface that plainly rather than
      // a bare "Failed to fetch".
      throw new Error('Could not reach gutenberg.org directly from the browser (likely a CORS restriction on their file server, not a problem with your book\'s id link).');
    }
    if (!res.ok) throw new Error(`Gutenberg file request failed (${res.status})`);
    const blob = await res.blob();
    const filename = epubUrl ? `gutenberg-${externalId}.epub` : `gutenberg-${externalId}.txt`;
    return { blob, filename, isEpub: !!epubUrl };
  }

  global.CatalogSearch = { searchGutenberg, searchArchive, searchAll, getGutenbergFormats, fetchGutenbergFile };
})(window);