/* =============================================================================
   login.js — the dashboard login view.
   -----------------------------------------------------------------------------
   POST /api/login {username, password, remember} → 200 sets the httpOnly
   `studio_session` cookie (server side). On success we route into the dashboard;
   on 401 we show an inline "invalid credentials" error. Fully keyboard-operable,
   labelled, password reveal toggle, mobile-friendly.
============================================================================= */

import { login, ApiError } from "./api.js";
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
      // success — cookie is set by the server; route into the dashboard.
      passEl.value = "";
      onSuccess && onSuccess({ username });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        showError("Invalid username or password.");
      } else if (err instanceof ApiError && err.status === 404) {
        showError("Login is not available on this server build.");
      } else if (err instanceof ApiError && err.code === "network") {
        showError("Cannot reach the Studio server. Is it running?");
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
