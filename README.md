# Bibliotheca — Book Tracker & Reader

A private, single-page library for tracking what you read, with a built-in distraction-free reader that can pull public-domain books straight from Project Gutenberg and the Internet Archive. No mandatory backend, no forced accounts — everything lives in your browser's `localStorage` by default, with optional cloud sync and full export/import to JSON.

---

## Table of Contents

- [Overview](#overview)
- [The Library (`index.html`)](#the-library-indexhtml)
  - [Almirahs & Shelves](#almirahs--shelves)
  - [Books & Spines](#books--spines)
  - [The Hover/Click Card](#the-hoverclick-card)
  - [Editing a Book (Alt+Click)](#editing-a-book-altclick)
  - [Shelf Colours](#shelf-colours)
  - [The Manage Panel](#the-manage-panel)
  - [Backup: Export & Import](#backup-export--import)
- [Linking Books to Online Copies](#linking-books-to-online-copies)
  - [How Linking Works](#how-linking-works)
  - [Searching Project Gutenberg & Internet Archive](#searching-project-gutenberg--internet-archive)
  - [Availability Badges](#availability-badges)
  - [Format Preference Logic](#format-preference-logic)
- [The Reader (`reader.html`)](#the-reader-readerhtml)
  - [Opening Books](#opening-books)
  - [Automatic Fetching for Linked Books](#automatic-fetching-for-linked-books)
  - [Loading Feedback & Progress](#loading-feedback--progress)
  - [EPUB Rendering](#epub-rendering)
  - [PDF Rendering](#pdf-rendering)
  - [Bookmarks](#bookmarks)
  - [Sticky Notes](#sticky-notes)
  - [Dark Mode & Reading Themes](#dark-mode--reading-themes)
- [Cloud Sync (Optional)](#cloud-sync-optional)
- [The Gutenberg Proxy (Supabase Edge Function)](#the-gutenberg-proxy-supabase-edge-function)
- [Data Model & Storage Keys](#data-model--storage-keys)
- [File Structure](#file-structure)
- [Setup](#setup)
- [Known Limitations](#known-limitations)
- [Data & Privacy](#data--privacy)

---

## Overview

Bibliotheca is two static HTML pages that work together:

1. **`index.html`** — the library. Organize books into themed cabinets ("almirahs"), track reading progress, and link books to free online copies.
2. **`reader.html`** — a dedicated reading view for EPUB and PDF files, with bookmarking, sticky notes, and automatic fetching of linked books.

Everything runs client-side. You can open `index.html` directly as a `file://` page with zero setup, or host both pages on something like GitHub Pages for access from any device (combined with the optional cloud sync described below).

---

## The Library (`index.html`)

### Almirahs & Shelves

Books are organized into a two-level hierarchy modeled on a real bookcase:

- **Almirahs** (cabinets) are the top level. Each has a name, an optional description, and a **theme** — one of seven built-in colour palettes (Philosophy, Classics, Literature, Fiction, Poetry, Science & Speculation, Biography & History). The theme controls the accent colour, shelf label colour, and the automatic spine-colour palette for that almirah.
- **Shelves** live inside an almirah. Each shelf has its own title, an optional description, and can hold any number of books.
- Navigate between almirahs using the `‹` / `›` arrows above the shelves; the current almirah's theme repaints the page's accent colours as you switch.

### Books & Spines

Each book is rendered as a hand-drawn wooden spine on its shelf, with:

- **Deterministic spine colour** — if you haven't set a custom colour, the spine colour is derived from a hash of the book's ID, so it stays the same across reloads without needing to be stored.
- **Author name and title** printed vertically on the spine, sized to fit.
- A **bookmark ribbon** indicator on unread books.
- Click a spine to toggle it between read/unread instantly.

### The Hover/Click Card

Clicking (or hovering, depending on device) a spine pops up a card showing:

- Title, author, and any note you've attached
- Reading progress (pages read/total) and bookmark percentage, if available
- **📖 Read this book** — opens the book in `reader.html`
- **🔗 Link to online copy** — opens the [linking modal](#linking-books-to-online-copies) to attach a Project Gutenberg or Internet Archive source to this book, without needing to go through the Manage panel. The button relabels to "🔗 Linked — manage" once a source is attached.
- Click the book's ID (shown in the card) to copy it to your clipboard.

### Editing a Book (Alt+Click)

Alt+click any spine to open the edit panel, where you can change:

- Read/unread status
- Pages read / pages total
- Start date and completion date
- A free-text note
- The book's individual spine colour (overriding the automatic deterministic colour), via 30 presets or a custom RGB picker

### Shelf Colours

Click the ⚙ icon on any shelf header to open its colour settings. You can pick a flat background colour for the whole shelf board from the same 30-colour palette, use a custom colour, or reset it back to the almirah's theme default.

### The Manage Panel

Below the shelves, the **Manage Collection** panel gives you a flat, expandable tree of every almirah → shelf → book, letting you:

- Rename almirahs, change their theme, or delete them
- Add, rename, or delete shelves within an almirah
- Add new books directly (author, title, optional note)
- Edit or delete individual books
- Access the **🔗 Link** action per book (the original way to open the linking modal, still available here alongside the hover-card shortcut)

### Backup: Export & Import

- **Export Backup** captures everything in `localStorage` — the full library, bookmarks, and settings — as a single downloadable JSON file.
- **Import** restores from that JSON file, replacing the current local state.
- Since everything is local-first, exporting regularly is the only way to guard against browser data being cleared or a device switch — unless you've set up [cloud sync](#cloud-sync-optional).

---

## Linking Books to Online Copies

Any book on your shelf can be paired with a free, public-domain copy hosted on **Project Gutenberg** or the **Internet Archive**, so that opening it in the reader can fetch the file automatically instead of requiring a manual upload.

### How Linking Works

- Each book keeps its own permanent 6-digit app ID (`generateBookId()`), which is the key that never changes regardless of where the actual file lives.
- A separate lookup table (`book-sources.js`) maps that ID to `{ source, externalId, title, author }` — just enough to re-identify where the file comes from. No file content or full catalog metadata is stored locally; everything else (cover image, description) is fetched fresh from the source each time it's needed.
- A book can be linked to **at most one** external source at a time — it's either a manual upload/your own file, or a public-domain source, not both simultaneously.
- Opening the link modal (via the hover card's 🔗 button or the Manage panel) shows the book's current link status, if any, and lets you search for a new one or change it.

### Searching Project Gutenberg & Internet Archive

The link modal searches both catalogs at once:

- **Project Gutenberg**, via the community-run [Gutendex](https://gutendex.com) API — clean JSON results (title, author, ID, cover) without needing Gutenberg's own bulk catalog files.
- **Internet Archive**, via its `advancedsearch.php` endpoint, restricted to `texts`-type items.

Results from both sources are shown side by side. A failure in one source (e.g. Archive is briefly down) doesn't block results from the other. A progress bar animates above the results while the search is in flight, so a slow lookup doesn't look frozen.

There's deliberately **no fuzzy auto-matching** — search returns candidates, and a human picks the correct edition. Matching a book's external ID by name-matching alone is exactly the kind of ambiguity a fixed local ID is meant to avoid.

### Availability Badges

Because not every catalog entry actually has a file this app can open (see [Format Preference Logic](#format-preference-logic) below — some Archive items are raw, undigitized scans with no EPUB or PDF derivative at all), every search result shows a small badge:

- **EPUB** / **PDF** / **TEXT** — a readable format was found; this edition can be fetched automatically
- **unavailable** — no compatible file was found for this specific edition; picking it will let you link it, but automatic fetching in the reader will fail with an explanation
- **?** — the availability check itself failed (e.g. a network hiccup), distinct from a confirmed "unavailable"

These badges are filled in *after* the search results render (each is its own lightweight follow-up lookup, checked in parallel), so the result list itself appears immediately rather than waiting on every availability check to finish first.

### Format Preference Logic

- **Gutenberg** fetches prefer **EPUB**, falling back to plain text if that's all a book offers. Gutenberg's EPUBs are hand-curated, not auto-generated, so they're reliably well-formed.
- **Internet Archive** fetches prefer **PDF** over Archive's own auto-generated EPUB derivative. This was a deliberate fix: Archive's automated EPUB conversion can produce malformed manifests (a confirmed real-world case had a spine entry with an undefined `href`, which crashes the EPUB renderer deep inside its internal queue with an error that never surfaces — the book just hangs forever with no visible failure). The PDF is the actual scanned source file and doesn't go through that conversion step, making it the more reliable default even though EPUB is nicer to read. A plain OCR `.txt` transcript is deliberately never offered as a fallback, since the reader can't open bare text files either way.

---

## The Reader (`reader.html`)

A separate, distraction-free page for actually reading — opened either from a library book's card or directly.

### Opening Books

- Drag-and-drop or use the file picker to open any local `.epub` or `.pdf` file.
- If the book on your shelf is linked to an online source, opening it from the library automatically triggers a fetch instead of asking you to find the file yourself.

### Automatic Fetching for Linked Books

When you open a book linked to Gutenberg or Archive:

1. The reader looks up the book's source via `book-sources.js`.
2. For **Gutenberg**, the file is fetched through a Supabase Edge Function proxy (see below) since Gutenberg's file servers don't reliably send CORS headers for direct browser fetches.
3. For **Archive**, files are fetched directly — archive.org's download URLs generally do send the right CORS headers, so no proxy is needed there.
4. If fetching fails, the reader shows the specific reason (not a generic "Failed to fetch") and a fallback link to download the file manually and open it from the Books panel — the book's link stays intact either way.

### Loading Feedback & Progress

- Opening any file (local or fetched) shows a spinner overlay on top of the reader surface — layered on top rather than replacing the viewer underneath, since epub.js needs the container to have real dimensions to render into.
- Network fetches show **live download progress** — bytes downloaded vs. total size when the server reports one (e.g. "Downloading… 50.3 MB of 419.5 MB"), or just bytes-received-so-far when it doesn't. This makes it possible to tell a slow-but-working download apart from one that's actually stuck.
- Metadata lookups (checking what formats/files a book has) time out after 15 seconds rather than hanging indefinitely on a stalled request.
- Actually rendering an opened book (displaying the first page, laying out, restoring your bookmark) is guarded by a similar timeout, so a malformed file fails with a clear error instead of leaving you on a stuck loading screen forever.
- Progress/percentage-through-book calculation (`epub.js`'s `locations.generate()`) runs *after* the book is already visible on screen, not before — this can be a slow step on long books, and there's no reason to make the reader appear frozen while it finishes in the background.

### EPUB Rendering

Rendered with **epub.js**, reflowable by default, two-page spread capable. Supports the reader's theme, font, and zoom controls, and computes reading-progress percentage via generated location data.

### PDF Rendering

Rendered with **pdf.js**, canvas-based, page by page — generally faster to get the first page visible than EPUB since it doesn't need to parse the whole document upfront.

### Bookmarks

Your reading position (as an EPUB CFI or a PDF page number) is saved automatically and restored the next time you open that book, so you always resume where you left off.

### Sticky Notes

A sidebar sticky-note pad lets you jot down thoughts per book as you read, styled like a physical adhesive note attached to the page.

### Dark Mode & Reading Themes

Toggle a dark reading theme for low-light reading; the paper background, ink colour, and sidebar all adjust accordingly.

---

## Cloud Sync (Optional)

Sync is entirely opt-in and additive — the app works fully offline without it.

- Powered by **Supabase** (Postgres + magic-link auth). Sign in with just an email address; no password required.
- A lightweight registry pattern: any module can call `BiblioSync.registerSyncTarget({...})` to have one of its `localStorage` keys synced, each with its own rules for what gets uploaded and how a pull merges back in. Two targets are registered:
  - **Library** (rack/shelf/book structure) — only the fields needed to reconstruct the shelf layout are uploaded (title, author, done status); your local notes, dates, and custom colours for existing books are preserved and never overwritten by a pull, only refreshed on title/author/done.
  - **Book sources** (the Gutenberg/Archive ID pairings) — merged additively; a pairing made on one device is never overwritten by another device's pull, since a book's source pairing is fixed at import time.
- Writes are debounced (1.5s) and pushed automatically in the background whenever a registered `localStorage` key changes.
- On sign-in, everything registered is pulled and merged in immediately.

---

## The Gutenberg Proxy (Supabase Edge Function)

GitHub Pages (and most static hosts) can't fetch Gutenberg's EPUB files directly from the browser — Gutenberg's file servers don't send the CORS headers browsers require for cross-origin fetches. A small Supabase Edge Function (`gutenberg-proxy`) solves this: the browser calls the function, the function fetches from Gutenberg server-side (no CORS restriction applies to server-to-server requests), and streams the result back with the right headers attached.

The proxy only allows `https://gutenberg.org` and `https://www.gutenberg.org` as targets — any other host is rejected — so it can't be repurposed as an open proxy.

Deploy it once with:
```
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy gutenberg-proxy --no-verify-jwt
```

Internet Archive doesn't need an equivalent proxy, since its download endpoints are generally CORS-friendly already.

---

## Data Model & Storage Keys

All data lives in `localStorage` under a handful of keys:

| Key | Contents |
|---|---|
| `bibliotheca-library-v4` | The full almirah → shelf → book structure |
| `bibliotheca-bookmarks` | Reading position per book |
| `bibliotheca-book-sources` | Book ID → external source (Gutenberg/Archive) pairing |
| `bibliotheca-sync-reloaded-once` (sessionStorage) | Internal guard to avoid reload loops after a sync pull |

Each book object carries: `id` (6-digit app ID, permanent), `author`, `title`, `note`, `done`, `pagesRead`, `pagesTotal`, `startDate`, `completionDate`, and an optional custom `color`.

---

## File Structure

```
index.html            — the library view (shelves, almirahs, manage panel, linking modal)
reader.html            — the reading view (EPUB/PDF rendering, bookmarks, notes)
book-sources.js        — local directory mapping book IDs to external catalog sources
catalog-search.js      — search + fetch logic for Project Gutenberg and Internet Archive
supabase-sync.js       — optional auth + sync layer shared by both pages
supabase/
  config.toml          — Edge Function config (disables JWT verification for the proxy)
  functions/
    gutenberg-proxy/
      index.ts          — CORS proxy for fetching Gutenberg files from the browser
README.md
```

---

## Setup

1. Open `index.html` in any modern browser — no build step, no dependencies. Works immediately as a local `file://` page.
2. To host it (e.g. on GitHub Pages), just push both HTML files and the accompanying `.js` files to a repo with Pages enabled.
3. To enable **Gutenberg auto-reading** on a hosted deployment, deploy the included Edge Function once (see [above](#the-gutenberg-proxy-supabase-edge-function)).
4. To enable **cloud sync**, fill in your own Supabase project's URL and anon key in `supabase-sync.js` (the anon key is safe to expose client-side — row-level security is what actually protects the data).

---

## Known Limitations

- Internet Archive items that are raw, undigitized scans (no EPUB or PDF derivative — only page-image files and a torrent) can't be opened automatically; you'll need to read those directly on archive.org.
- Very large linked files (some Archive scans exceed 400MB) will genuinely take a long time to download — there's no local caching, so re-opening a linked book re-downloads it every time in the current version.
- Sync is last-write-wins at the per-key level; concurrent edits to the same book from two devices before a sync round-trip can overwrite each other.

---

## Data & Privacy

All data stays in your browser's `localStorage` unless you explicitly enable cloud sync — nothing is sent anywhere by default. Use **Export Backup** regularly regardless, since `localStorage` can be cleared by the browser or lost if you switch devices.