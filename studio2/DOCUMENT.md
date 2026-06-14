# studio2/ — Studio v2 ("edit a video on the phone without uploading it")

Milestone M1 "Core Loop". The authoritative contracts live in
`PM/arch-2026-06-12-m1-core-loop.md` (architecture) and
`PM/plan-2026-06-12-m1-core-loop.md` (feature plan). Studio v1 (`studio/`)
stays byte-untouched and keeps running on 8420/8443 — both stacks run
side by side on one host.

## Layout

| Path | What it is | Owner / step |
|---|---|---|
| `relay/` | FastAPI brain relay — auth, TLS, agent, device-tool bridge. Carries **JSON and static files only, never media**. HTTP :8520 / HTTPS :8543. | pm-backend (Step 1 scaffold; Step 3 bridge+agent+chat) |
| `pwa/` | Installable vanilla-JS PWA (no build step) — projects in OPFS, lossless cut engine (vendored mediabunny), skip-preview player, export. Served by the relay at `/static/*`. | pm-frontend (Steps 2/4/5) |
| `relay/.runtime/` | Runtime state (session secret, v2's own TLS leaf, logs). Gitignored. | created at runtime |

## Trust model (the one thing to never break)

v2 **shares Studio v1's certificate authority** (read from
`studio/.runtime/tls/`, READ-ONLY, configurable via `STUDIO2_CA_DIR`) and
signs its **own leaf** into `relay/.runtime/tls/`. v2 NEVER writes to or
regenerates the CA — phones that completed v1's Secure Setup trust v2 with
zero re-trust. CA missing → relay serves HTTP-only and prints "run Studio v1
once or set STUDIO2_CA_DIR".

## Decisions captured here

- Separate `studio2/` service instead of growing v1 (arch trade-off 9) —
  v1 stays untouched until M4 migrates.
- Ports 8520/8543 (PM resolution 3); cookies `studio2_session` /
  `__Host-studio2_session` with an independent signing secret (arch §8.2 —
  the host cookie jar is shared with v1, so names+secret must differ).
- Own `config.toml [users]` (PM resolution 4) — accounts decoupled from v1.
- v2 starts its own `ASSET_VERSION = "1"` lineage (PM resolution 7).
