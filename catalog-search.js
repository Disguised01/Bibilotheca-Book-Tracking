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
  // Small helper: fetch that gives up after `ms` instead of hanging
  // forever on a stalled/blocked request (e.g. a huge raw-scan item with
  // no CDN, or a request that silently never resolves).
  async function fetchWithTimeout(url, ms, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(ms / 1000)}s — the server may be slow or unreachable.`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Downloads a URL as a Blob while reporting progress via onProgress({
  // loaded, total }) — total is null if the server didn't send a size.
  // No overall timeout here (large legitimate files can take minutes),
  // but progress ticking proves it's actually moving rather than stuck.
  async function fetchBlobWithProgress(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`File request failed (${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || null;
    if (!res.body || !res.body.getReader) {
      // Streaming not supported (older browser) — fall back to a plain blob.
      const blob = await res.blob();
      if (onProgress) onProgress({ loaded: blob.size, total: blob.size });
      return blob;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress) onProgress({ loaded, total });
    }
    return new Blob(chunks);
  }

  // Gutendex is a community-run read API over Project Gutenberg's catalog
  // — no key needed, returns clean JSON (title/author/id), which is far
  // easier to work with than Gutenberg's own bulk RDF/catalog files.
  const GUTENDEX_BASE = 'https://gutendex.com/books';
  const GUTENBERG_PROXY = 'https://ewwhbstfgyzmjrmiufaq.supabase.co/functions/v1/gutenberg-proxy';
  const METADATA_TIMEOUT_MS = 15000;

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
    const res = await fetchWithTimeout(`${GUTENDEX_BASE}/${externalId}`, METADATA_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Could not look up Gutenberg book #${externalId} (${res.status})`);
    const data = await res.json();
    return data.formats || {};
  }

  // Prefer EPUB (renders with epub.js already in the app); fall back to
  // plain text if that's all this particular book offers.
  function pickGutenbergFile(formats) {
    const epubUrl = Object.entries(formats).find(([mime]) => mime === 'application/epub+zip')?.[1];
    const textUrl = Object.entries(formats).find(([mime]) => mime.startsWith('text/plain'))?.[1];
    return { epubUrl, textUrl, url: epubUrl || textUrl };
  }

  /** Lightweight check for the link-search UI: does this Gutenberg book have a readable format? */
  async function checkGutenbergAvailability(externalId) {
    try {
      const formats = await getGutenbergFormats(externalId);
      const { epubUrl, url } = pickGutenbergFile(formats);
      if (!url) return { available: false };
      return { available: true, format: epubUrl ? 'epub' : 'text' };
    } catch (e) {
      return { available: false, unknown: true };
    }
  }

  async function fetchGutenbergFile(externalId, onProgress) {
    const formats = await getGutenbergFormats(externalId);
    const { epubUrl, textUrl, url } = pickGutenbergFile(formats);
    if (!url) throw new Error('This Gutenberg book has no EPUB or plain-text format available.');

    let blob;
    try {
      const proxyUrl = `${GUTENBERG_PROXY}?url=${encodeURIComponent(url)}`;
      blob = await fetchBlobWithProgress(proxyUrl, onProgress);
    } catch (e) {
      // A network-level failure with no response at all is the CORS
      // fingerprint mentioned above — surface that plainly rather than
      // a bare "Failed to fetch".
      if (e.message && e.message.includes('Request timed out')) throw e;
      throw new Error('Could not reach gutenberg.org directly from the browser (likely a CORS restriction on their file server, not a problem with your book\'s id link).');
    }
    const filename = epubUrl ? `gutenberg-${externalId}.epub` : `gutenberg-${externalId}.txt`;
    return { blob, filename, isEpub: !!epubUrl };
  }

  // ── Internet Archive file fetch ──────────────────────────────────────
  // Archive.org's metadata endpoint lists every file for an item; unlike
  // Gutenberg's static file servers, archive.org download URLs generally
  // do send CORS headers, so this can usually fetch directly without a
  // proxy. If it still fails with no status code, that's the same CORS
  // fingerprint as the Gutenberg case, not a problem with the id pairing.
  async function getArchiveFiles(identifier) {
    const res = await fetchWithTimeout(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, METADATA_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Could not look up Archive item "${identifier}" (${res.status})`);
    const data = await res.json();
    return data.files || [];
  }

  // Prefer EPUB (renders with epub.js already in the app); fall back to
  // a PDF (the reader already supports PDFs, and many Google-scanned
  // items on Archive only ship a PDF with no EPUB derivative). A plain
  // OCR ".txt" transcript is deliberately not offered as a fallback —
  // this reader can't open bare text files either way.
  function pickArchiveFile(identifier, files) {
    const epubFile = files.find(f => (f.format || '').toLowerCase().includes('epub') || /\.epub$/i.test(f.name || ''));
    // Avoid picking up small excerpt/abbyy PDFs when a proper full PDF exists;
    // prefer a file literally named "<identifier>.pdf" if present, else any .pdf.
    const pdfFile = files.find(f => f.name === `${identifier}.pdf`) ||
      files.find(f => (f.format || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(f.name || ''));
    return { epubFile, pdfFile, chosen: epubFile || pdfFile };
  }

  /** Lightweight check for the link-search UI: does this Archive item have a readable file? */
  async function checkArchiveAvailability(identifier) {
    try {
      const files = await getArchiveFiles(identifier);
      const { epubFile, chosen } = pickArchiveFile(identifier, files);
      if (!chosen) return { available: false };
      return { available: true, format: epubFile ? 'epub' : 'pdf' };
    } catch (e) {
      return { available: false, unknown: true };
    }
  }

  async function fetchArchiveFile(identifier, onProgress) {
    const files = await getArchiveFiles(identifier);
    const { epubFile, chosen } = pickArchiveFile(identifier, files);
    if (!chosen) throw new Error('This Archive item has no EPUB or PDF file available.');

    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name)}`;
    let blob;
    try {
      blob = await fetchBlobWithProgress(url, onProgress);
    } catch (e) {
      if (e.message && (e.message.includes('Request timed out') || e.message.includes('File request failed'))) throw e;
      throw new Error('Could not reach archive.org directly from the browser (likely a CORS restriction on this file, not a problem with your book\'s id link).');
    }
    const filename = epubFile ? `archive-${identifier}.epub` : `archive-${identifier}.pdf`;
    return { blob, filename, isEpub: !!epubFile };
  }

  global.CatalogSearch = {
    searchGutenberg, searchArchive, searchAll,
    getGutenbergFormats, fetchGutenbergFile, checkGutenbergAvailability,
    getArchiveFiles, fetchArchiveFile, checkArchiveAvailability,
  };
})(window);