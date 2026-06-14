# studio2/pwa/assets/music/ — built-in CC0 music library (M3)

The bundled music-bed library for the M3 "Add music" feature. **All 8 tracks are
CC0 1.0 Universal (public domain)** — no attribution required, freely
redistributable inside the shipped app. Vendored into the repo at build time
(repo convention: zero CDN, zero runtime fetch — FreePD.com itself shut down in
2025, so the source mirrors must never be a runtime dependency).

## What's here

| File | Role |
|---|---|
| `<library_id>.m4a` × 8 | The audio beds. AAC, stereo, 48 kHz, loudness-normalized. |
| `catalog.json` | The library index `list_music_library` reads. |
| `DOCUMENT.md` | This file. |

`add_music {track_ref:{library_id}}` resolves a `library_id` from `catalog.json`
to the matching `<library_id>.m4a` and copies the bundled bytes into the
project's `music/` on first use.

## The 8 tracks (all CC0-1.0)

| library_id | Title | Artist | Mood | Dur (s) | Source |
|---|---|---|---|---|---|
| `calm_piano_01` | Lovely Piano Song | Rafael Krux | calm | 95.9 | FreePD `Romance/Lovely Piano Song.mp3` |
| `acoustic_ukulele_01` | Happy Whistling Ukulele | Kevin MacLeod | acoustic | 123.4 | FreePD `Upbeat/Happy Whistling Ukulele.mp3` |
| `upbeat_city_01` | City Sunshine | Bryan Teoh | upbeat | 185.0 | FreePD `Upbeat/City Sunshine.mp3` |
| `cinematic_mountain_01` | Lonely Mountain | Rafael Krux | cinematic | 190.4 | FreePD `Epic/Lonely Mountain.mp3` |
| `epic_heroic_01` | Heroic Adventure | Rafael Krux | epic | 142.9 | FreePD `Epic/Heroic Adventure.mp3` |
| `ambient_space_01` | Space Ambience | Kevin MacLeod | ambient | 275.7 | FreePD `Electronic/Space Ambience.mp3` |
| `world_rasta_01` | Sunny Rasta | Bryan Teoh | world | 140.2 | FreePD `World/Sunny Rasta.mp3` |
| `playful_adventure_01` | Big person, tiny cities (world map's theme) | Komiku | playful | 297.1 | FMA album `It's time for adventure! vol 3` |

Total bundle ≈ **29 MB** (28.6 MiB) for the 8 `.m4a` files. These ship in the
app; this is the on-disk cost of the built-in library.

## Provenance & CC0 verification

- **Tracks 1–7 (FreePD)** — fetched from the **`0lhi/FreePD` GitHub mirror**
  (`raw.githubusercontent.com/0lhi/FreePD/stream/<Category>/<Title>.mp3`). The
  mirror's repository-root `LICENSE` is **CC0 1.0 Universal** (verified — the
  file opens with "Creative Commons Legal Code / CC0 1.0 Universal"). FreePD's
  entire catalog is dedicated to the public domain. The MacLeod-via-FreePD
  files are additionally cross-verified on Wikimedia Commons, which accepts only
  genuinely-free files. Exact `source_url`s are in `catalog.json`.
- **Track 8 (Komiku)** — "Big person, tiny cities (world map's theme)" from the
  album *It's time for adventure! vol 3*, published by Komiku (Monplaisir) on the
  **Free Music Archive** under **CC0 1.0 Universal**. The actual bytes were
  fetched from the verified CC0 copy on **Wikimedia Commons**
  (`commons.wikimedia.org/wiki/File:Komiku_-_08_-_Big_person_tiny_cities.ogg`,
  dedication "Creative Commons CC0 1.0 Universal Public Domain Dedication") — the
  FMA download endpoint did not expose a stable direct file URL, and Wikimedia
  only hosts genuinely-free files, so this is a fetch of the same CC0 work, not a
  license substitution. `source_url` in `catalog.json` points at the FMA track
  page (the canonical CC0 release); the Wikimedia OGG (4:57, matching the FMA
  duration exactly) was the actual download.

All licenses confirmed against the **M3 spec** (`PM/m3-music-library-tracks.md`),
which itself was produced by a license-verification research pass. License-unsafe
sources (Pixabay, Mixkit, Scott Holmes free tier) were excluded per that spec.

## Normalization applied

Each source was re-encoded with ffmpeg:

- **Loudness:** two-pass EBU R128 `loudnorm` to **I = −18 LUFS**, TP = −1.5 dBTP,
  LRA = 11 (linear mode, measured-values fed from pass 1). Verified output:
  every track lands at −18.0 to −18.1 LUFS integrated, true peak well under
  0 dBFS — so beds sit consistently under speech without clipping. −18 LUFS
  (vs. the −14/−16 of streaming-loud masters) leaves headroom for the on-device
  mixer to duck under dialogue.
- **Format:** AAC (`-c:a aac -b:a 160k`), **stereo**, **48 kHz** (`-ar 48000
  -ac 2`), `+faststart` (moov atom at front for fast first-decode). Consistent
  with the on-device audio mixer and smaller than the source MP3s.
- **Cleanup:** video/cover-art streams dropped (`-vn`); all metadata stripped
  (`-map_metadata -1`) — no embedded tags ship.

Source MP3/OGG downloads were staged in a throwaway `_raw/` dir during the build
and removed; only the final `.m4a` + `catalog.json` + this file are committed.

## In-app courtesy line

CC0 requires no attribution, but a courtesy credit is appropriate. Surface in the
music UI: **"Public-domain music via FreePD / Komiku."** No per-track credits
screen is needed (that's exactly why the lean all-CC0 set was chosen over the
CC-BY options).
