/* =============================================================================
   login.js — the Studio v2 login view (v1 pattern against arch §2.1).
   -----------------------------------------------------------------------------
   POST /api/login {username, password, remember} → 200 sets the httpOnly
   session cookie server-side (`__Host-studio2_session` on https,
   `studio2_session` on http). On success we hand off to app.js; on 401 we
   show an inline "invalid credentials" error (uniform — the server never
   distinguishes unknown-user from wrong-password). Fully keyboard-operable,
   labelled, password reveal toggle, phone-friendly.
============================================================================= */

import { login, isNetworkError } from "./api.js";
import { byId } from "./util.js";

export function initLogin({ onSuccess }) {
  const form     = byId("login-form");
  const userEl   = byId("login-username");
  const passEl   = byId("login-password");
  const rememberEl = byId("login-remember");
  const submitEl = byId("login-submit");
  const submitLabel = submitEl.querySelector(".btn__label");
  const errorEl  = byId("login-error");
  const errorTextEl = byId("login-error-text");
  const revealEl = byId("login-reveal");

  /* password reveal toggle */
  revealEl.addEventListener("click", () => {
    const showing = passEl.type === "text";
    passEl.type = showing ? "password" : "text";
    revealEl.setAttribute("aria-pressed", String(!showing));
    revealEl.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    const use = revealEl.querySelector("use");
    use.setAttribute("href", "/static/assets/icons.svg#" + (showing ? "i-eye" : "i-eye-off"));
    passEl.focus();
  });

  function showError(message) {
    errorTextEl.textContent = message;
    errorEl.dataset.show = "true";
  }
  function clearError() { errorEl.dataset.show = "false"; }

  /* clear the error as soon as the user edits anything */
  [userEl, passEl].forEach((n) => n.addEventListener("input", clearError));

  function setBusy(busy) {
    submitEl.disabled = busy;
    userEl.disabled = busy;
    passEl.disabled = busy;
    submitLabel.textContent = busy ? "Signing in…" : "Sign in";
    form.setAttribute("aria-busy", String(busy));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) {
      showError("Enter your username and password.");
      (!username ? userEl : passEl).focus();
      return;
    }

    setBusy(true);
    try {
      await login(username, password, rememberEl.checked);
      // success — cookie is set by the server; route onward.
      passEl.value = "";
      onSuccess && onSuccess({ username });
    } catch (err) {
      if (err && err.status === 401) {
        showError("Invalid username or password.");
      } else if (isNetworkError(err)) {
        showError("Cannot reach Studio right now. Check the connection — your projects still open offline.");
      } else {
        showError((err && err.message) || "Sign-in failed. Please try again.");
      }
      passEl.focus();
      passEl.select && passEl.select();
    } finally {
      setBusy(false);
    }
  });

  /** Reset the form when returning to login (e.g. after logout). */
  function reset() {
    clearError();
    setBusy(false);
    passEl.value = "";
  }

  function focus() {
    (userEl.value ? passEl : userEl).focus();
  }

  return { reset, focus };
}
