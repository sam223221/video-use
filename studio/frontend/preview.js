/* =============================================================================
   preview.js — HTML5 preview player + output picker + verify-PNG lightbox.
   -----------------------------------------------------------------------------
   Plays rendered output via the Range-aware /api/file endpoint. Authentication
   rides the same-origin studio_session cookie (sent automatically by <video>/
   <img>) — no credential ever appears in the URL.
   Reacts to GET /api/outputs (picker of preview/final) and refreshes when the
   agent finishes a render. Verify PNGs open in an accessible lightbox.
   Playback: setOutputs({autoplay:true}) — the render-done path AND the chat
   ready-card's Play button — actually STARTS playback. A play request is ARMED
   per video (keyed on the src minus the &_= cache-bust) and survives reloads of
   the same file: play() is called synchronously (preserving the click's user
   gesture), and persistent readiness listeners (loadedmetadata/loadeddata/
   canplay) retry until it sticks. Only switching to a DIFFERENT video, a user
   pause, or an autoplay-policy block cancels it. (The previous one-shot
   loadedmetadata listener was silently killed whenever ANY later source touch —
   e.g. the chat artifact auto-open reloading the same file under an unbusted
   URL — called playPath again: the live "Play never plays" P1.)
============================================================================= */

import { fileUrl } from "./api.js";
import { byId, el, icon, fmtDuration, basename, trapFocus } from "./util.js";

/* True for an already-absolute path: Windows drive ("X:\\"/"X:/"), UNC
   ("\\\\server"), or POSIX ("/…"). Used to decide whether a caller-supplied
   artifact string is already servable by /api/file as-is. */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/;
function isAbsolutePath(p) {
  return typeof p === "string" && ABSOLUTE_PATH_RE.test(p);
}

export function initPreview() {
  const video      = byId("preview-video");
  const videoFrame = byId("video-frame");
  const videoEmpty = byId("video-empty");
  const select     = byId("preview-select");
  const meta       = byId("preview-meta");
  const verifySection = byId("verify-section");
  const verifyStrip = byId("verify-strip");
  const downloadEl = byId("preview-download");
  const downloadLabel = byId("preview-download-label");

  const lightbox   = byId("lightbox");
  const lightboxImg = byId("lightbox-img");
  const lightboxCap = byId("lightbox-cap");
  const lightboxClose = byId("lightbox-close");

  let outputs = [];        // [{key,label,path,duration_s,mtime}]
  let lbReleaseTrap = null;
  let lbLastFocus = null;

  /* ---- video source switching ---- */
  function showVideo(show) {
    videoEmpty.style.display = show ? "none" : "grid";
    // [data-empty] lets styles.css hide the sourceless <video> while the
    // placeholder owns the frame — its disabled native controls would
    // otherwise sit under (and visually collide with) the placeholder copy.
    if (videoFrame) videoFrame.dataset.empty = show ? "false" : "true";
  }

  /* One ARMED play request at a time, keyed on the video's identity (the src
     URL with the trailing &_=<mtime> cache-bust stripped — the bust is always
     APPENDED last in playPath, so the strip is exact). Unlike a one-shot
     loadedmetadata listener, the armed request SURVIVES reloads of the same
     file (busted vs unbusted URL), which is exactly how the render-done
     autoplay and the ready-card Play were being dropped: chat's artifact
     auto-open reloaded the same mp4 and the queued play was lost. It is
     cancelled only by (a) an explicit switch to a DIFFERENT video, (b) a user
     pause (native controls stay authoritative), or (c) an autoplay-policy
     rejection. */
  let pendingPlay = null;          // { base: <src minus cache-bust> } | null
  function stripBust(u) {
    return String(u || "").replace(/&_=[^&]*$/, "");
  }
  function tryPlay() {
    if (!pendingPlay) return;
    const want = pendingPlay;
    const p = video.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        if (pendingPlay === want) pendingPlay = null;   // playback started
      }).catch((err) => {
        // Autoplay-policy rejection (no user gesture yet) fails SILENT by
        // design — the ready-card's Play button is the gesture affordance.
        // Anything else (AbortError from an interleaved load()) keeps the
        // request armed; the readiness listeners below retry once the
        // (re)loaded source can play.
        if (err && err.name === "NotAllowedError" && pendingPlay === want) pendingPlay = null;
      });
    } else {
      pendingPlay = null;   // ancient engines: play() returned undefined — assume started
    }
  }
  /* Retry the armed play whenever the element reaches a playable state. These
     listeners are PERSISTENT (never removed), so no later reload can strand
     the request the way removing a one-shot listener did. */
  function maybeResumePlay() {
    if (!pendingPlay) return;
    if (!video.paused) { pendingPlay = null; return; }   // already playing
    if (stripBust(video.currentSrc || video.src) !== pendingPlay.base) return;  // foreign source
    tryPlay();
  }
  ["loadedmetadata", "loadeddata", "canplay"].forEach((ev) =>
    video.addEventListener(ev, maybeResumePlay));
  // A real pause (native controls) must win over any queued autoplay retry.
  // load() never fires `pause` (it fires emptied/abort), so this only catches
  // genuine user/script pause() calls.
  video.addEventListener("pause", () => { pendingPlay = null; });

  /* Load `absPath` into the player; with {play:true} also start playback.
     When the requested URL is already loaded or loading we do NOT reload
     (Play on the ready-card right after the render-done autoplay just plays,
     keeping position). play() is invoked SYNCHRONOUSLY (user-gesture context
     preserved); if the source isn't ready yet the armed request is fulfilled
     by the readiness listeners above — even if another reload of the SAME
     video lands in between. */
  function playPath(absPath, info, opts = {}) {
    if (!absPath) return;
    // cache-bust on mtime so a re-render reloads the new file
    const bust = info && info.mtime ? "&_=" + info.mtime : "";
    const url = fileUrl(absPath) + bust;
    let absUrl = url;
    try { absUrl = new URL(url, window.location.href).href; } catch { /* keep relative */ }
    const sameSrc = video.src === absUrl;
    const ready   = sameSrc && video.readyState >= HTMLMediaElement.HAVE_METADATA;
    const loading = sameSrc && video.networkState === HTMLMediaElement.NETWORK_LOADING;
    const base = stripBust(absUrl);
    if (opts.play) {
      pendingPlay = { base };                 // arm (or re-target) the play request
    } else if (pendingPlay && pendingPlay.base !== base) {
      pendingPlay = null;                     // switching to a DIFFERENT video cancels it
    }
    if (!ready && !loading) {
      video.src = url;
      video.load();
    }
    showVideo(true);
    renderMeta(info);
    if (opts.play) tryPlay();   // synchronous — preserves the click's user-gesture context
  }

  function renderMeta(info) {
    const bits = [];
    if (info && info.duration_s) bits.push(el("span", { class: "tc", text: fmtDuration(info.duration_s) }));
    if (info && info.path) bits.push(el("span", { text: basename(info.path), title: info.path }));
    meta.replaceChildren(...bits);
  }

  select.addEventListener("change", () => {
    const opt = outputs.find((o) => o.key === select.value);
    if (opt) playPath(opt.path, opt);
  });

  /* ---- consume /api/outputs ---- */
  function setOutputs(data, opts = {}) {
    outputs = [];
    if (data && data.preview && data.preview.exists) {
      outputs.push({ key: "preview", label: "Draft preview", path: data.preview.path, duration_s: data.preview.duration_s, mtime: data.preview.mtime });
    }
    if (data && data.final && data.final.exists) {
      outputs.push({ key: "final", label: "Final video", path: data.final.path, duration_s: data.final.duration_s, mtime: data.final.mtime });
    }

    /* Download affordance (pane header): the journey's ending. Prefers the
       FINAL render (the deliverable), falls back to the draft. The href is the
       streaming URL + &download=1 (Content-Disposition: attachment). */
    const best = outputs.find((o) => o.key === "final") || outputs[0] || null;
    if (downloadEl) {
      if (best && best.path) {
        downloadEl.hidden = false;
        downloadEl.href = fileUrl(best.path) + "&download=1";
        downloadEl.setAttribute("download", basename(best.path) || "video.mp4");
        if (downloadLabel) downloadLabel.textContent = best.key === "final" ? "Download" : "Download draft";
        downloadEl.title = best.key === "final" ? "Download your video" : "Download the draft preview";
      } else {
        downloadEl.hidden = true;
        downloadEl.removeAttribute("href");
      }
    }

    if (outputs.length === 0) {
      select.replaceChildren(el("option", { value: "", text: "No outputs yet" }));
      select.disabled = true;
      showVideo(false);
      meta.replaceChildren();
    } else {
      select.disabled = false;
      select.replaceChildren(...outputs.map((o) => el("option", { value: o.key, text: o.label })));
      // pick: prefer the one requested (e.g., clicked final); on a render-done
      // autoplay pick the NEWEST file (a fresh draft must not lose to a stale
      // final); else first.
      let pick = outputs[0];
      if (opts.prefer) {
        const p = outputs.find((o) => o.key === opts.prefer); if (p) pick = p;
      } else if (opts.autoplay && outputs.length > 1) {
        pick = outputs.reduce((a, b) => (((b.mtime || 0) > (a.mtime || 0)) ? b : a), outputs[0]);
      }
      // only auto-load if nothing playing or a render just finished;
      // autoplay (render-done / ready-card Play) also STARTS playback
      const shouldLoad = opts.autoplay || !video.src || opts.prefer;
      select.value = pick.key;
      if (shouldLoad) playPath(pick.path, pick, { play: !!opts.autoplay });
    }

    // verify PNGs
    const pngs = (data && data.verify_pngs) || [];
    if (pngs.length) {
      verifySection.hidden = false;
      verifyStrip.replaceChildren(...pngs.map((p) =>
        el("button", { class: "verifythumb", type: "button", title: p.name,
          onclick: () => openLightbox(p.path, p.name) }, [
          el("img", { src: fileUrl(p.path), alt: "Verify frame " + p.name, loading: "lazy" }),
        ])));
    } else {
      verifySection.hidden = true;
      verifyStrip.replaceChildren();
    }
  }

  /* ---- open a specific artifact (from chat tool-end or outputs click) ----
     `relOrAbsPath` is used only to pick the branch (png/mp4/text) and for the
     caption/alt; the URL we actually open is the ABSOLUTE path. The caller
     (chat.js / panel.js) resolves the artifact's absolute path and passes it as
     `info.path`. /api/file can't serve a bare edit-relative string ("edit/…"),
     so we require an absolute path: when one isn't available we no-op cleanly
     rather than build a URL that would 403. */
  function absPathFor(relOrAbsPath, info) {
    if (info && info.path) return info.path;
    if (isAbsolutePath(relOrAbsPath)) return relOrAbsPath;
    return null;
  }
  function openArtifact(relOrAbsPath, info) {
    if (/\.png$|\.jpg$/i.test(relOrAbsPath)) {
      const abs = absPathFor(relOrAbsPath, info);
      if (abs) openLightbox(abs, basename(relOrAbsPath));
      return;
    }
    if (/\.mp4$/i.test(relOrAbsPath)) {
      const abs = absPathFor(relOrAbsPath, info);
      if (abs) playPath(abs, info || {});
      return;
    }
    // Text outputs (.srt / .json / .md, etc.): the player can't render them, so
    // open them in a new browser tab via the Range-aware /api/file endpoint.
    const abs = absPathFor(relOrAbsPath, info);
    if (abs) {
      window.open(fileUrl(abs), "_blank", "noopener,noreferrer");
    }
  }

  /* ---- lightbox ---- */
  function openLightbox(absPath, caption) {
    lbLastFocus = document.activeElement;
    lightboxImg.src = fileUrl(absPath);
    lightboxImg.alt = caption || "Frame";
    lightboxCap.textContent = caption || "";
    lightbox.dataset.open = "true";
    lbReleaseTrap = trapFocus(lightbox);
    document.documentElement.style.overflow = "hidden";
    lightboxClose.focus();
  }
  function closeLightbox() {
    lightbox.dataset.open = "false";
    lightboxImg.src = "";
    if (lbReleaseTrap) { lbReleaseTrap(); lbReleaseTrap = null; }
    document.documentElement.style.overflow = "";
    if (lbLastFocus && document.contains(lbLastFocus)) { try { lbLastFocus.focus(); } catch {} }
  }
  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightbox.dataset.open === "true") { e.preventDefault(); closeLightbox(); }
  });

  return {
    setOutputs,
    openArtifact,
    /** Called after a render finishes — reload outputs & autoplay newest. */
    onRenderDone() { /* the panel reloads /api/outputs and calls setOutputs with autoplay */ },
  };
}
