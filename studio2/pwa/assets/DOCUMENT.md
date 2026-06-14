# studio2/pwa/assets/ — fonts, icons, sprite

Everything here is **vendored — zero CDN, zero external requests at runtime**
(repo convention; verified in the Step-2 Playwright run).

## Typography (NEW v2 choices — deliberately not v1's set, not Inter)

| Face | Files | Role |
|---|---|---|
| **Bricolage Grotesque** | `bricolage-grotesque-{500,600,700}.woff2` | Display — headings, project names, brand. High-character grotesque. |
| **Schibsted Grotesk** | `schibsted-grotesk-{400,500,600,700}.woff2` | Body — crisp at phone sizes. |
| **Spline Sans Mono** | `spline-sans-mono-{400,500}.woff2` | Data — ids, timecodes, byte counts, quota line. |

Latin subsets, woff2, downloaded 2026-06-12 from Google Fonts (all three are
OFL-licensed). `@font-face` rules live in `../styles.css`; `index.html`
preloads `bricolage-grotesque-600` + `schibsted-grotesk-400` for an on-brand
first paint.

## PWA icons (`icons/`)

The mark: **"the splice"** — a play triangle cut in two along a slanted edit
line, the halves nudged apart like two shots butted on a timeline. Two-tone
timecode teal (`#3ee0d2` / `#20b4aa`) on the deep slate ground (`#0a0d10`,
subtle top-left lift). Generated with a Pillow script (supersampled 4×,
LANCZOS downscale); design is swappable later per PM resolution #6.

| File | Size | Notes |
|---|---|---|
| `icon-192.png` | 192² | Rounded-rect (22% radius), transparent corners. |
| `icon-512.png` | 512² | Same, hi-res. |
| `maskable-512.png` | 512² | Full-bleed ground; mark at 52% — inside the 80% safe zone. `purpose: maskable`. |
| `apple-touch-icon.png` | 180² | Full-bleed square (iOS applies its own corner mask). |

## UI sprite (`icons.svg`)

24×24 grid, 1.8px stroke, round caps/joins, `currentColor`. Used via
`util.icon(name)` → `<use href="/static/assets/icons.svg#i-…">`. Current set:
close, check, alert, spark, eye, eye-off, logout, plus, trash, refresh,
chevron-right, back, download, play, film, folder-plus, offline, storage,
shield, phone — plus the Step-5 additions (same grid): send, stop, pause,
scissors, undo, doc, share.
