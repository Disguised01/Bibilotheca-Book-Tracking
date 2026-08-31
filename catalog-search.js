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

  // Extracts an Archive identifier from either a bare identifier or a
  // full archive.org URL (details/download/embed pages, with or without
  // a trailing /page/N/mode/2up viewer path).
  function parseArchiveIdentifier(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    const match = trimmed.match(/archive\.org\/(?:details|download|embed)\/([^/?#]+)/i);
    if (match) return decodeURIComponent(match[1]);
    if (/^[a-zA-Z0-9._-]+$/.test(trimmed)) return trimmed; // looks like a bare identifier
    return null;
  }

  // Extracts a Gutenberg ebook number from either a bare number or a
  // full gutenberg.org URL.
  function parseGutenbergId(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    const match = trimmed.match(/gutenberg\.org\/(?:ebooks|files|cache\/epub)\/(\d+)/i);
    if (match) return match[1];
    if (/^\d+$/.test(trimmed)) return trimmed;
    return null;
  }

  /**
   * Resolve a manually-entered Archive URL/identifier into a full
   * candidate result — same normalized shape as searchArchive() — by
   * fetching the item's real title/author from its metadata, so it can
   * be linked exactly like a search result even though it never showed
   * up in search (e.g. a title search miss, or a niche public-domain
   * upload search doesn't surface well).
   */
  async function resolveArchiveLink(input) {
    const identifier = parseArchiveIdentifier(input);
    if (!identifier) throw new Error('Could not find an Archive identifier in that link. Paste the full archive.org/details/... URL or just the identifier.');
    const res = await fetchWithTimeout(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, METADATA_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Could not find Archive item "${identifier}" (${res.status}) — check the link is correct and the item is public.`);
    const data = await res.json();
    if (!data || !data.metadata) throw new Error(`Archive item "${identifier}" has no accessible metadata — it may be private or restricted.`);
    const meta = data.metadata;
    return {
      source: 'archive',
      externalId: identifier,
      title: meta.title || identifier,
      author: Array.isArray(meta.creator) ? meta.creator[0] : (meta.creator || 'Unknown'),
      coverUrl: `https://archive.org/services/img/${identifier}`,
      files: data.files || [],
    };
  }

  /**
   * Same idea for a manually-entered Gutenberg URL/ebook number.
   */
  async function resolveGutenbergLink(input) {
    const id = parseGutenbergId(input);
    if (!id) throw new Error('Could not find a Gutenberg ebook number in that link. Paste the full gutenberg.org/ebooks/... URL or just the number.');
    const res = await fetchWithTimeout(`${GUTENDEX_BASE}/${id}`, METADATA_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Could not find Gutenberg book #${id} (${res.status}).`);
    const book = await res.json();
    return {
      source: 'gutenberg',
      externalId: String(book.id),
      title: book.title || 'Untitled',
      author: (book.authors && book.authors[0] && book.authors[0].name) || 'Unknown',
      coverUrl: (book.formats && book.formats['image/jpeg']) || null,
      formats: book.formats || {},
    };
  }

  /**
   * Given a pasted link/ID of either kind, figure out which source it
   * is and resolve it. Tries Archive first if the input looks like an
   * archive.org URL or Gutenberg first if it looks like a gutenberg.org
   * URL or bare number; otherwise tries both and returns whichever
   * resolves (a bare alphanumeric identifier is ambiguous between the
   * two, so this covers that case too).
   */
  async function resolveManualLink(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) throw new Error('Paste a link or ID first.');
    if (/gutenberg\.org/i.test(trimmed)) return resolveGutenbergLink(trimmed);
    if (/archive\.org/i.test(trimmed)) return resolveArchiveLink(trimmed);
    if (/^\d+$/.test(trimmed)) return resolveGutenbergLink(trimmed); // bare number → assume Gutenberg ebook id
    return resolveArchiveLink(trimmed); // bare alphanumeric → assume Archive identifier
  }

  // Prefer a PDF over Archive's own auto-generated EPUB derivative.
  // Archive's EPUB conversion is automated and can produce malformed
  // manifests (confirmed case: a spine item with an undefined href,
  // which crashes epub.js deep inside its render queue with an
  // uncaught exception that never rejects the awaited promise — the
  // book just hangs forever with no error). The PDF is the actual
  // scanned source and doesn't go through that conversion, so it's
  // the more reliable default here even though epub.js is nicer to
  // read. (Gutenberg's EPUBs are hand-curated, not auto-derived, so
  // that fetch path still prefers EPUB.)
  function pickArchiveFile(identifier, files) {
    const epubFile = files.find(f => (f.format || '').toLowerCase().includes('epub') || /\.epub$/i.test(f.name || ''));
    // Avoid picking up small excerpt/abbyy PDFs when a proper full PDF exists;
    // prefer a file literally named "<identifier>.pdf" if present, else any .pdf.
    const pdfFile = files.find(f => f.name === `${identifier}.pdf`) ||
      files.find(f => (f.format || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(f.name || ''));
    return { epubFile, pdfFile, chosen: pdfFile || epubFile };
  }

  /** Lightweight check for the link-search UI: does this Archive item have a readable file? */
  async function checkArchiveAvailability(identifier) {
    try {
      const files = await getArchiveFiles(identifier);
      const { chosen } = pickArchiveFile(identifier, files);
      if (!chosen) return { available: false };
      const isEpub = /\.epub$/i.test(chosen.name || '') || (chosen.format || '').toLowerCase().includes('epub');
      return { available: true, format: isEpub ? 'epub' : 'pdf' };
    } catch (e) {
      return { available: false, unknown: true };
    }
  }

  async function fetchArchiveFile(identifier, onProgress) {
    const files = await getArchiveFiles(identifier);
    const { chosen } = pickArchiveFile(identifier, files);
    if (!chosen) throw new Error('This Archive item has no EPUB or PDF file available.');

    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name)}`;
    let blob;
    try {
      blob = await fetchBlobWithProgress(url, onProgress);
    } catch (e) {
      if (e.message && (e.message.includes('Request timed out') || e.message.includes('File request failed'))) throw e;
      throw new Error('Could not reach archive.org directly from the browser (likely a CORS restriction on this file, not a problem with your book\'s id link).');
    }
    const isEpub = /\.epub$/i.test(chosen.name || '') || (chosen.format || '').toLowerCase().includes('epub');
    const filename = isEpub ? `archive-${identifier}.epub` : `archive-${identifier}.pdf`;
    return { blob, filename, isEpub };
  }

  global.CatalogSearch = {
    searchGutenberg, searchArchive, searchAll,
    getGutenbergFormats, fetchGutenbergFile, checkGutenbergAvailability,
    getArchiveFiles, fetchArchiveFile, checkArchiveAvailability,
    resolveArchiveLink, resolveGutenbergLink, resolveManualLink,
  };
})(window);