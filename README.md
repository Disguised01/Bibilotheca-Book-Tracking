# Bibliotheca — Book Tracker & Reader

A private, single-page library for tracking what you read. Books live on hand-drawn wooden shelves grouped into "almirahs" (cabinets), each with its own colour theme. No backend, no accounts — everything is saved to your browser's `localStorage`, with full export/import to JSON.

## Features

- **Almirahs & shelves** — organize books into themed cabinets (Philosophy, Classics, Fiction, Poetry, Sci-Fi, Biography, Literature), each with multiple shelves inside
- **Per-book tracking** — mark read/unread, pages read/total, start date, completion date
- **Custom colours** — pick a flat colour per shelf from 30 presets or a custom RGB picker, or set an individual book's spine colour (alt+click a book to edit)
- **Deterministic spine colours** — unmarked books get a colour derived from their ID, consistent across reloads
- **Reading table** (`reader.html`) — a separate distraction-free reading/bookmarking view
- **Full backup** — Export Backup captures *everything* in localStorage (library + bookmarks + settings) as one JSON file; Import restores it
- **No dependencies** — two static HTML files, works by just opening them in a browser

## Usage

Open `index.html` in any modern browser. Add an almirah at the bottom of the page, add shelves inside it, add books to a shelf. Click a book spine to toggle read/unread. Alt+click a book to edit its progress, dates, and colour. Click the ⚙ on a shelf to set its colour.

## Files

- `index.html` — the library view (shelves, almirahs, manage panel)
- `reader.html` — the reading table view

## Data & Privacy

All data stays in your browser's localStorage — nothing is sent anywhere. Use **Export Backup** regularly since localStorage can be cleared by the browser or lost if you switch devices.

---

