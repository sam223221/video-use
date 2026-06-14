# studio2/pwa/store/ — OPFS persistence layer

Pure persistence (arch §1.4): OPFS only, **no media parsing, no DOM, no
fetch**. OPFS is the single source of truth for projects — the relay never
sees a byte of it.

## Layout owned (arch §5.1)

```
(OPFS root)/projects/prj_<hex12>/
  meta.json        ← meta.js (the ONLY runtime writer; M3: gains a `render` block)
  clips/           ← Step 4 ingest writes clip_<hex8>.<ext>
  clipmeta/        ← meta.js writeClipMeta/readClipMeta/listClipMetas
  edl.jsonl        ← store/edl.js (Step 4) — see init-op note below
  chat.json        ← Step 5 chat.js
  exports/         ← verified outputs only (temp names never survive)
  transcripts/     ← store/transcripts.js (M2): clip_<hex8>.json per clip;
                     the transient clip_<hex8>.m4a.tmp extraction spool lives
                     here too (engine/audio.js writes it, the boot sweep clears
                     orphans). Created on demand by the first writer.
  music/           ← store/music.js (M3): trk_<hex8>.<ext> original track bytes
                     + trkmeta/trk_<hex8>.json metadata. Device-only — music
                     NEVER transits the relay (arch §9). Created on demand.
```

## Files

### `opfs.js` — plumbing
- **Ids:** `PROJECT_ID_RE` (`^prj_[0-9a-f]{12}$`), `CLIP_ID_RE`
  (`^clip_[0-9a-f]{8}$`), `newProjectId()`, `newClipId()`. Every dir helper
  validates the id **before** touching the filesystem (defense in depth — ids
  also arrive via bridge commands, arch §8.3).
- **Dirs:** `projectDir`, `projectSubDir`, `listProjectIds`,
  `removeProjectDir` (recursive delete).
- **Atomic writes, two tiers:**
  - `writeJSONAtomic(dir, name, obj)` — whole-document via
    `createWritable()` + `close()` (OPFS swap-on-close = atomic commit).
    For meta/clipmeta/chat documents.
  - `tempWriter(dir, finalName)` — streamed outputs (banked #3): bytes land
    in `<final>.tmp`; `close()` commits the tmp so it can be **verified**;
    `commit()` renames via `FileSystemFileHandle.move()` (streamed-copy +
    delete fallback via `moveEntry()` when `move` is unsupported — probed by
    capability.js); `abandon()` aborts + best-effort deletes, never throws,
    never masks the original error. The final name is NEVER a write target.
- **Boot sweep:** `sweepTmp()` deletes `*.tmp` orphans in every project dir +
  its `clips/`, `exports/` and (M2) `transcripts/`. Never throws; returns
  swept names for diag. Called by app.js at boot. The `transcripts/` branch
  clears the audio-extraction spool (`clip_*.m4a.tmp`) left by a crash between
  extract and the caller's `abandon()` (arch §5.1) — proven by the T2 harness's
  mid-extract-failure check.
- **Quota:** `storageEstimate()` and `quotaPreflight(bytes, headroom=5%)` —
  pass-open when the estimate API is missing (the real write surfaces real
  errors). `requestPersist()` wraps `navigator.storage.persist()`.
- **Crash marker** (LS key `studio2.op.marker.v1`): `setOpMarker(op,
  projectId, data?)` / `clearOpMarker()` around heavy ops (Step 4 ingest,
  Step 5 export), `takeOpMarker()` = read-and-clear, claimed once at boot by
  app.js. It is a *user-facing interruption signal*, not a recovery mechanism
  — the journal's torn-tail tolerance is the recovery story.

### `meta.js` — project + clip metadata (the only writer of these files)
- `createProject(name?)` → `prj_` id, subdir skeleton (clips/clipmeta/exports),
  `meta.json {schema:1,id,name,created_at,updated_at}`. Empty names get a
  dated default ("Project 12 Jun"). Names are labels — no uniqueness.
- `listProjects()` → newest-touched first; a dir with missing/torn meta.json
  still lists as `broken:true` (deletable, not openable) so damage is visible
  instead of silently eating storage.
- `getProject` / `touchProject` (best-effort updated_at bump) /
  `deleteProject` (permanent rmtree — caller confirms with the user).
- `writeClipMeta` / `readClipMeta` / `listClipMetas`, `countClips`.
- All reads tolerate missing/torn JSON (null/skip, never throw).

#### M3 render block (arch §2.1) — additive, backward-compatible

`meta.json` gains an OPTIONAL `render` block. `meta.schema` is `1` for M1/M2
projects and bumps to `2` the first time a render setter writes. **A missing
render block (every M1/M2 project, and a fresh schema-2 project) reads as the
documented default** via `normalizeRenderBlock()` — match_primary canvas,
contain fit, blurred background, no per-clip overrides = "lossless, as today".
This is THE load-bearing backward-compat regression: old projects read
byte-for-byte unchanged; `createProject()` still writes `schema:1` (no render
block) and a project only becomes schema-2 once the user/agent sets a format.

```jsonc
"render": {
  "canvas": { "mode": "preset"|"match_primary"|"custom", "preset"?, "primary_clip_id"?,
              "width", "height", "fps", "background": "blur"|"black" },   // width/height/fps RESOLVED (engine reads these)
  "default_fit": "contain"|"cover",
  "fits": { "clip_<id>": { "mode", "background"? } }                       // SPARSE — only clips differing from default_fit
}
```

- **API:** `getRenderBlock(projectId)` (default-filled, never null for a live
  project), `normalizeRenderBlock(raw)` (PURE; the single place a raw render
  field becomes trusted — drives default-fill on read), `effectiveFit(render,
  clipId)` (sparse override else default_fit + canvas background),
  `setCanvas(projectId, spec)` (resolves the spec via `engine/canvas.js`
  `resolveCanvas` against the live clips, persists the RESOLVED dims, bumps
  schema), `setClipFit(projectId, clipId, {mode, background?, clear?})` (SPARSE
  write; `clear:true` removes the override → falls back to default),
  `setDefaultFit(projectId, fit)`.
- **`fits` stays sparse** — a clip absent from `fits` uses `default_fit` +
  `canvas.background`, so adding a clip needs no fit write.
- **One-writer-per-file preserved:** all render-block mutation goes through
  `mutateRender()` (read-modify-write meta.json atomically); `meta.js` remains
  the only writer of meta.json. Canvas + fit are PROJECT SETTINGS
  (last-write-wins, no undo/audit need) — deliberately in meta.json, NOT the
  EDL journal (contrast music, which IS timeline data — see edl.js below).
- `meta.js` imports `engine/canvas.js` for `resolveCanvas` + the preset
  table + defaults — a one-way edge (canvas.js imports nothing).

## Step 4 contract note (edl.js)

`createProject()` deliberately does **not** write the EDL `init` op —
`edl.jsonl` does not exist until `store/edl.js` (Step 4) first opens the
project and writes it lazily. This keeps one-writer-per-file intact (edl.js is
the only journal writer, arch §1.4) and means a Step-2-created project is
valid input for Step 4 with zero migration.

### `edl.js` — the EDL journal (Step 4; the ONLY writer of edl.jsonl)

Append-only JSONL (arch §5.2): ops `init` / `add_clip` / `remove_clip` /
`apply_cuts` / `undo`; undo is itself an op pointing at `of_seq`. State is
whatever folds from the lines that parse — the journal IS the crash-recovery
mechanism (iOS kills are uncatchable).

- **API:** `readState(projectId)` (folds + lazily writes the `init` op on a
  fresh project — THE first-open entry point), `appendAddClip`,
  `appendRemoveClip`, `appendApplyCuts` (cuts carry BOTH `requested` and
  `snapped` boundaries — snapped at edit time by `engine/probe.js` §5.3, so
  preview and export agree exactly), `appendUndo` (targets the last un-undone
  `apply_cuts`; throws `engine_error` "nothing to undo"), `findCommand`,
  `foldOps` (pure, exported for tests), `invalidate` (drop cache after
  out-of-band changes / project delete).
- **Append mechanics:** `createWritable({keepExistingData:true})` + ONE
  positioned write at the end of the last GOOD line + `truncate` + `close()`
  — OPFS swap-on-close makes each append atomic. Payloads pass
  `engine/writers.normalizeBufferSource` (banked #1 insurance).
- **Torn-tail tolerance + heal:** an unparseable final line is dropped at
  load with a notice (`notices` in `readState`); the next append overwrites
  it and truncates — the file heals. Mid-file garbage is skipped with a
  notice; seq gaps are reported, never hidden.
- **Idempotency (arch §3.6):** ops may carry `command_id`
  (`^cmd_[0-9a-f]{12}$`, device-validated); a duplicate append returns the
  ORIGINAL op's outcome (`deduped:true`) without writing a second line.
- **Fold:** `add_clip` → full-range segment (duration from clipmeta via
  `meta.js` — the journal line stays exactly the arch §5.2 shape),
  `apply_cuts` → subtract each snapped range (splitting segments),
  `remove_clip` → drop the clip, `undo` → target marked inert + refold.
  Folded keep-list cached per project, invalidated on append; the journal is
  read once per open.
- **Singleton state (`window.__studio2Edl`):** the fold cache AND the
  per-project append mutex live on a window singleton because store modules
  load under two URLs (?v= + bare — the documented wart). Two module
  instances therefore share one serialized writer chain — one-writer-per-file
  holds even across the double-load seam.
- **Undo scope (M1):** only `apply_cuts` ops are undo targets —
  `add_clip`/`remove_clip` are clip lifecycle, and undoing a `remove_clip`
  could not resurrect a deleted clip file.

#### M3 music ops (arch §2.2/§2.3) — music placement IS journal data

Music placement is conversational edit data the user undoes like cuts, so it
lives in THIS append-only journal (not a separate music.json), reusing
crash-safety + `command_id` idempotency + undo + the single fold for free. New
ops extend the fold WITHOUT touching the append mechanics:

- `add_music {track_id, placement:{at_s, duration_s|null, track_offset_s,
  gain_db, fade_in_s, fade_out_s, duck:{enabled, under, amount_db, attack_s,
  release_s}}}` — its `seq` becomes the **music_seq** handle
  update/remove target (parallel to undo's `of_seq`). `duration_s:null` =
  "under the whole video" (clamped to the timeline end at fold time).
- `update_music {music_seq, placement:{…partial…}}` — merges the provided
  fields onto the live placement.
- `remove_music {music_seq}` — drops it. The existing `undo {of_seq}` also
  covers music (undoing an `add_music` seq marks it inert in the fold).
- **API:** `appendAddMusic` / `appendUpdateMusic` / `appendRemoveMusic` (same
  shape + `command_id` idempotency + torn-tail tolerance as the M1 ops; all
  validate the track id `^trk_[0-9a-f]{8}$`, bound the placement numbers, and
  re-target a LIVE music_seq for update/remove). The CALLER ensures the track
  exists in `store/music.js`; a placement of a missing/deleted track folds as
  a notice, never a crash.
- **Placement bounds (device re-validates the relay's caps, arch §9):** gain
  −60…+6 dB, fades 0…10 s, duck amount −60…0 dB, duck attack/release 0…5 s.
  Out-of-range numbers are CLAMPED (never rejected) so a folded placement is
  always mixable.
- **Fold output gains `music`:** `foldOps` (and `readState`) now return
  `{ segments, timeline_duration_s, music, notices }`. `music` is the live
  placements flattened to `[{music_seq, track_id, at_s, duration_s,
  track_offset_s, gain_db, fade_in_s, fade_out_s, duck}]`, sorted by
  music_seq, with `at_s`/`duration_s` **clamped to the COMPOSED (post-cut)
  timeline** — a placement starting past the end is dropped with a notice (the
  same forward-compatible discipline used for unknown ops). Canvas + fit are
  NOT in the fold — they live in meta.json (read separately by the
  renderer/preview), keeping the fold a pure function of the journal.

### `transcripts.js` — per-clip transcripts (M2; the ONLY writer of transcripts/)

One JSON per transcribed clip at `transcripts/clip_<hex8>.json`, produced by
the relay's normalizer and written by the device. OPFS is the single source of
truth — the durable transcript lives ONLY on the device; the relay forgets
(arch §1.3, §3.2).

- **API:** `writeTranscript(projectId, clipId, doc)` (atomic via
  `opfs.writeJSONAtomic`; returns the canonical doc), `readTranscript`
  (validated, cached, null on missing/torn/foreign), `hasTranscript`,
  `listTranscriptClipIds` (sorted, derived purely by listing the dir),
  `deleteTranscript` (best-effort; → true/false), `invalidate(projectId?,
  clipId?)` (drop cache after an out-of-band change / project delete).
- **Schema (arch §4.2)** — `{schema:1, clip_id, provider, transcribed_at,
  language_code, language_probability?, audio_duration_s, text,
  words:[{w,s,e,c?}], audio_events:[{label,s,e}]}`. Compact word keys; `c`
  (=exp(logprob) 0..1) OMITTED when absent; **all times are SOURCE-clip seconds
  rounded to 2dp** — the same clock the EDL keep-list uses, so transcript ↔ EDL
  ↔ preview ↔ export never disagree (THE arch §4.2 invariant; cuts never
  rewrite the transcript).
- **Schema-validated on write AND read** (defense in depth): one
  `normalizeDoc(doc, clipId)` drives both — write of a malformed/foreign doc
  THROWS (the caller must never persist garbage, arch §7.1 step 8); read of a
  torn/malformed/foreign file returns null and NEVER throws (mirrors
  `opfs.readJSON` / `meta.readClipMeta`). A doc whose embedded `clip_id` ≠ the
  filename's id reads as null — a transcript can't describe another clip.
- **Existence is derived** by listing `transcripts/` — clipmeta is NOT touched
  (one-writer-per-file holds, arch §4.1).
- **Singleton cache (`window.__studio2Transcripts`):** memoizes validated docs
  per `(projectId, clipId)` (undefined=unknown, null=known-absent, object=
  present) across the ?v= + bare double-load seam, exactly like
  `edl.js`/`__studio2Edl`. Writes/deletes keep it coherent; `invalidate()`
  drops it.
- **Lifecycle:** a transcript's life is the clip's — re-transcribe overwrites
  atomically; a removed clip / degraded re-pick REPLACE deletes it (T4 wires
  `deleteTranscript` into `ingest.js`, arch §1.2/§10.7 — a transcript of the
  OLD audio must not survive the swap).
- **Pure persistence:** OPFS only — no media parsing, no DOM, no fetch.

### `music.js` — the per-project music track store (M3; the ONLY writer of music/)

Durable, **device-side-only** audio tracks at `music/trk_<hex8>.<ext>` + their
metadata at `music/trkmeta/trk_<hex8>.json`. A track is a user upload OR a copy
of a bundled royalty-free library track — stored as ORIGINAL bytes. **Music
never transits the relay** (arch §9); these bytes are mixed locally at render
time (Step 2). Mirrors meta.js conventions: atomic whole-document trkmeta
writes (`opfs.writeJSONAtomic`), tolerant reads (null/skip, never throw), ids
validated before any filesystem touch.

- **Ids:** `TRACK_ID_RE` (`^trk_[0-9a-f]{8}$`), `newTrackId()` (`trk_` + 8 hex,
  mirrors `clip_`/`prj_`). A `library_id` is allowlist-checked
  (`^[a-z0-9][a-z0-9_-]{0,62}$`) — no arbitrary path/fetch (arch §9).
- **trkmeta schema 1:** `{schema:1, track_id, source:"upload"|"library",
  library_id?, original_name, title?, artist?, license?, duration_s, codec,
  channels, sampleRate, size_bytes, ext, imported_at}`. One `normalizeTrkMeta`
  drives write AND read (defense in depth, like transcripts.js): a
  malformed/foreign doc (embedded `track_id` ≠ the filename id, or a library
  track missing its `library_id`) reads back as null and never reaches a
  consumer.
- **API:** `importTrack(projectId, bytes, meta)` (user upload — the CALLER has
  already probed + size/duration-capped + normalized the bytes, arch §9; this
  store does NOT parse media), `copyLibraryTrack(projectId, libraryId, bytes,
  catalogEntry)` (copies the bundled bytes into `music/` on first use,
  recording `source:"library"`, `library_id`, `license`), `readTrackMeta`,
  `readTrackFile` (bytes back as a File for the Step-2 mixer), `listTracks`
  (oldest-imported first; skips unreadable), `hasTrack`, `deleteTrack` (bytes +
  trkmeta; best-effort).
- **Write order = bytes then trkmeta:** a crash between the two leaves an
  ORPHAN bytes file with no trkmeta; `listTracks` only lists tracks WITH a
  readable trkmeta, so an orphan is invisible (never a half-track) and
  reclaimable by a future sweep. Bytes are written by streaming the source Blob
  (`blob.stream().pipeTo()`) — never buffered whole in the JS heap (device RAM
  is the constraint).
- **One-writer-per-file:** music.js is the only writer of `music/` + `trkmeta/`;
  `store/edl.js` references tracks by id (placement ops) but never writes them.
- **Pure persistence:** OPFS only — no media parsing, no DOM, no fetch.
  `newTrackId`/`TRACK_ID_RE` are defined locally (not added to `opfs.js`, which
  stays untouched by this step) but follow the identical `randHex` convention.
