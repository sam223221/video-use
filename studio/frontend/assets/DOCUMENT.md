# studio/frontend/assets/ — DOCUMENT

## What this is
Static, vendored frontend assets served at `/static/assets/*`. **Self-hosted, no
CDN** — the LAN may be offline-ish, so fonts and any in-page QR helper are
shipped locally (ARCHITECTURE.md §10.3).

## Scaffold status
Empty placeholder. The Frontend Engineer adds the real assets.

## File structure (target)
```
assets/
├── fonts/      # [TODO FE] self-hosted woff2 faces — display + text + mono. NOT Inter.
└── icons.svg   # [TODO FE] single SVG sprite of UI icons (referenced via <use>)
```

## Key decisions / constraints
- **Typography (ARCHITECTURE.md §7.4):** a characterful grotesque/transitional
  display face for headings + a humanist sans for body + a mono for
  timecodes/data. Final pairing is the FE's taste call (use the
  `ui-ux-pro-max` / `frontend-design` skills). Whatever is chosen must be
  vendored here as `woff2` and referenced from `styles.css` via `@font-face`.
- **No runtime network fonts** (no Google Fonts link) — vendor everything.

## How it connects
Referenced by `frontend/styles.css` (`@font-face`, icon `url()`s) and
`frontend/index.html`. Served as plain static files by `app.main`'s `/static`
mount.
