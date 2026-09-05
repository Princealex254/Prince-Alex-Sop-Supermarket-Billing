/* ==================================================================
   RetailFlow — app.js
   --------------------------------------------------------------
   The single shared application script for every RetailFlow page.
   As we build new pages we add modules here (guarded by element
   existence) instead of creating page-specific script files.

   Modules in this file:
     • showToast()        — toast notifications
     • validation helpers — field errors + loading buttons
     • initLoginPage()    — sign-in logic (login/index.html)
     • initForgotPassword() — reset-password modal (login/index.html)

   Auth stack:
     login/index.html → Firebase Auth → get ID token
     → (future) Cloudflare Worker API → D1 user/business record
     → authorized admin role (owner | admin | store_manager)
       → owner/index.html  (administration system)
     → new business → onboarding.html
   ================================================================== */

import {
  auth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut
} from "../firebase/firebase-config.js";

/* ------------------------------------------------ */
/* Shared configuration                              */
/* ------------------------------------------------ */
const CONFIG = {
  routes: {
    home: "/index.html",
    login: "/login/index.html",
    register: "/register.html",
    /******************************************************************
     * AFTER LOGIN, USERS GO TO THE ADMIN SYSTEM (owner/index.html).
     * owner.js performs the role check and keeps only authorized
     * roles (owner | admin | store_manager) inside the application.
     * A future Cloudflare Worker will enforce the same rule server-side.
     ******************************************************************/
    afterLogin: "/owner/index.html",
    pos: "/pos/index.html",           // POS terminal (cashier, sales staff, …)
    dashboard: "/dashboard.html",     // future: business POS dashboard
    onboarding: "/onboarding.html"    // future: post-register business setup
  },
  storageKeys: {
    rememberEmail: "retailflow.rememberedEmail"
  }
};

const API_BASE = "https://retailflow-api.princealexdigital.workers.dev";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------ */
/* Toast notifications (shared)                      */
/* ------------------------------------------------ */
export function showToast(type, title, message) {
  const icons = { success: "fa-circle-check", error: "fa-circle-exclamation", info: "fa-circle-info" };
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML =
    '<span class="toast-icon" aria-hidden="true"><i class="fa-solid ' + (icons[type] || icons.info) + '"></i></span>' +
    '<div class="toast-body"><strong></strong><p></p></div>' +
    '<button type="button" class="toast-x" aria-label="Dismiss notification">✕</button>';
  toast.querySelector(".toast-body strong").textContent = title;
  toast.querySelector(".toast-body p").textContent = message;

  document.getElementById("toastStack").appendChild(toast);

  let closing = false;
  let timer = null;
  const dismiss = () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove());
  };

  toast.querySelector(".toast-x").addEventListener("click", dismiss);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 1600); });
  timer = setTimeout(dismiss, 5000);
}

/* ------------------------------------------------ */
/* Form + validation helpers (shared)                */
/* ------------------------------------------------ */
export const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function setFieldError(fieldEl, message) {
  fieldEl.classList.add("has-error");
  const span = fieldEl.querySelector(".field-error span");
  if (span) span.textContent = message;
  const input = fieldEl.querySelector("input");
  if (input) input.setAttribute("aria-invalid", "true");
}

export function clearFieldError(fieldEl) {
  fieldEl.classList.remove("has-error");
  const input = fieldEl.querySelector("input");
  if (input) input.removeAttribute("aria-invalid");
}

export function setButtonLoading(btn, labelEl, loading, busyText, idleText) {
  if (loading) {
    btn.classList.add("is-loading");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    labelEl.textContent = busyText;
  } else {
    btn.classList.remove("is-loading");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    labelEl.textContent = idleText;
  }
}

/* ------------------------------------------------ */
/* Friendly Firebase error copy                      */
/* Raw SDK messages are never shown to the user.     */
/* ------------------------------------------------ */
export const FRIENDLY = {
  login(code) {
    switch (code) {
      case "auth/invalid-email":            return "Please enter a valid email address.";
      case "auth/user-disabled":            return "This account has been disabled. Please contact support.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials": return "Invalid email or password.";
      case "auth/too-many-requests":        return "Too many login attempts. Please try again later.";
      case "auth/network-request-failed":   return "Network error. Check your connection and try again.";
      default:                              return "Something went wrong. Please try again.";
    }
  },
  reset(code) {
    switch (code) {
      case "auth/invalid-email":            return "Please enter a valid email address.";
      case "auth/missing-email":            return "Please enter your email address.";
      case "auth/too-many-requests":        return "Too many requests. Please try again later.";
      case "auth/network-request-failed":   return "Network error. Check your connection and try again.";
      default:                              return "Something went wrong. Please try again.";
    }
  }
};

/* ------------------------------------------------ */
/* Login page (login/index.html)                     */
/* ------------------------------------------------ */
function initLoginPage() {
  const loginForm = $("loginForm");
  const emailInput = $("email");
  const passwordInput = $("password");
  const emailField = $("emailField");
  const passwordField = $("passwordField");
  const signInBtn = $("signInBtn");
  const signInLabel = $("signInLabel");
  const pwToggle = $("pwToggle");
  const rememberBox = $("remember");
  const loadingEl = $("authLoading");

  // Only run on the login page
  if (!loginForm || !emailInput || !passwordInput) return;

  let redirecting = false;
  let revealed = false;

  /* ---------- Remember me (email prefill) ---------- */
  function saveRememberedEmail(email) {
    try {
      if (rememberBox.checked) localStorage.setItem(CONFIG.storageKeys.rememberEmail, email);
      else localStorage.removeItem(CONFIG.storageKeys.rememberEmail);
    } catch (err) { /* storage disabled — ignore */ }
  }

  function restoreRememberedEmail() {
    try {
      const remembered = localStorage.getItem(CONFIG.storageKeys.rememberEmail);
      if (remembered) {
        emailInput.value = remembered;
        rememberBox.checked = true;
      }
    } catch (err) { /* storage disabled — ignore */ }
  }

  /* ---------- Reveal the page after session check ---------- */
  function revealAuth() {
    if (revealed) return;
    revealed = true;
    window.__authReady = true;
    restoreRememberedEmail();
    requestAnimationFrame(() => {
      loadingEl.classList.add("is-hidden");
      document.body.classList.add("auth-ready");
    });
  }

  /* ---------- Post-login routing ---------- */
  /*
   * Route by the user's D1 role (fetched from the Worker with the
   * Firebase ID token):
   *   owner | admin | store_manager → administration console
   *   cashier | sales_staff | waiter | inventory_manager | accountant
   *   and any other provisioned role → the POS terminal
   * Falls back to the administration console if the profile cannot be
   * loaded (the admin console re-checks and will deny access itself).
   */
  const ADMIN_ROLES = ["owner", "admin", "store_manager"];
  async function getPostLoginRoute() {
    try {
      const user = auth.currentUser;
      if (!user) return CONFIG.routes.afterLogin;
      const token = await user.getIdToken();
      const res = await fetch(API_BASE + "/auth/profile", {
        headers: { Authorization: "Bearer " + token }
      });
      if (!res.ok) return CONFIG.routes.afterLogin;
      const data = await res.json();
      const role = data && data.user && data.user.role;
      return ADMIN_ROLES.includes(role) ? CONFIG.routes.afterLogin : CONFIG.routes.pos;
    } catch (err) {
      console.warn("[RetailFlow] post-login role lookup failed:", err);
      return CONFIG.routes.afterLogin;
    }
  }

  function handleSignedIn(user) {
    if (redirecting) return;
    redirecting = true;
    if (user && user.emailVerified === false) {
      showToast("info", "Info", "Please verify your email before continuing.");
    }
    showToast("success", "Success", "Login successful. Redirecting…");
    getPostLoginRoute().then((route) => {
      setTimeout(() => { window.location.assign(route); }, 1000);
    });
  }

  /* ---------- Login submit ---------- */
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    let hasError = false;

    if (!email) {
      setFieldError(emailField, "Please enter your email address.");
      hasError = true;
    } else if (!isValidEmail(email)) {
      setFieldError(emailField, "Please enter a valid email address.");
      hasError = true;
    } else {
      clearFieldError(emailField);
    }

    if (!password) {
      setFieldError(passwordField, "Please enter your password.");
      hasError = true;
    } else {
      clearFieldError(passwordField);
    }

    if (hasError) {
      const firstInvalid = loginForm.querySelector(".field.has-error input");
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    saveRememberedEmail(email);
    authenticate(email, password);
  });

  async function authenticate(email, password) {
    setButtonLoading(signInBtn, signInLabel, true, "Signing in…", "Sign In");
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      handleSignedIn(credential.user);
    } catch (err) {
      console.warn("[RetailFlow] sign-in failed:", err.code);
      showToast("error", "Error", FRIENDLY.login(err.code));
    } finally {
      setButtonLoading(signInBtn, signInLabel, false, "", "Sign In");
    }
  }

  /* Clear inline errors as the user types */
  [emailInput, passwordInput].forEach((input) => {
    input.addEventListener("input", () => {
      const field = input.closest(".field");
      if (field) clearFieldError(field);
    });
  });

  /* ---------- Password visibility toggle ---------- */
  pwToggle.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    pwToggle.setAttribute("aria-pressed", String(show));
    pwToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    pwToggle.querySelector("i").className = show ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
  });

  /* ---------- Auth state ----------
     If a user is already authenticated, skip the login screen and go
     straight to the app. Otherwise reveal the sign-in form. */
    onAuthStateChanged(auth, (user) => {
    if (user) {
      if (redirecting) return;
      redirecting = true;
      getPostLoginRoute().then((route) => { window.location.assign(route); });
      return;
    }
    revealAuth();
  });
}
/* ------------------------------------------------ */
/* Forgot password modal (login/index.html)          */
/* ------------------------------------------------ */
function initForgotPassword() {
  const forgotModal = $("forgotModal");
  const forgotForm = $("forgotForm");
  const forgotEmail = $("forgotEmail");
  const forgotEmailField = $("forgotEmailField");
  const forgotFormWrap = $("forgotFormWrap");
  const forgotSuccess = $("forgotSuccess");
  const forgotSendBtn = $("forgotSendBtn");
  const forgotSendLabel = $("forgotSendLabel");
  const forgotCloseBtn = $("forgotClose");
  const forgotCancelBtn = $("forgotCancel");
  const forgotDoneBtn = $("forgotDone");
  const loginEmailInput = $("email");

  if (!forgotModal || !forgotForm) return;

  let lastFocused = null;

  function openForgotModal() {
    forgotFormWrap.hidden = false;
    forgotSuccess.hidden = true;
    forgotForm.reset();
    clearFieldError(forgotEmailField);

    lastFocused = document.activeElement;
    forgotModal.classList.add("open");
    forgotModal.removeAttribute("aria-hidden");
    document.body.classList.add("modal-open");
    setTimeout(() => forgotEmail.focus(), 120);
  }

  function closeForgotModal() {
    forgotModal.classList.remove("open");
    forgotModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  $("forgotLink").addEventListener("click", (e) => {
    e.preventDefault();
    openForgotModal();
  });
  forgotCloseBtn.addEventListener("click", closeForgotModal);
  forgotCancelBtn.addEventListener("click", closeForgotModal);
  forgotDoneBtn.addEventListener("click", closeForgotModal);
  forgotModal.addEventListener("click", (e) => {
    if (e.target === forgotModal) closeForgotModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && forgotModal.classList.contains("open")) closeForgotModal();
  });

  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = forgotEmail.value.trim();
    if (!email) {
      setFieldError(forgotEmailField, "Please enter your email address.");
      forgotEmail.focus();
      return;
    }
    if (!isValidEmail(email)) {
      setFieldError(forgotEmailField, "Please enter a valid email address.");
      forgotEmail.focus();
      return;
    }
    clearFieldError(forgotEmailField);

    setButtonLoading(forgotSendBtn, forgotSendLabel, true, "Sending…", "Send Reset Link");
    try {
      await sendPasswordResetEmail(auth, email);

      // Prefill the main login form with the same email for convenience
      if (loginEmailInput) loginEmailInput.value = email;

      // Treat unknown accounts like success too — never reveal whether an
      // email exists (prevents account enumeration).
      forgotFormWrap.hidden = true;
      forgotSuccess.hidden = false;
      showToast("success", "Success", "Password reset instructions have been sent to your email.");
      setTimeout(() => forgotDoneBtn.focus(), 120);
    } catch (err) {
      console.warn("[RetailFlow] password reset failed:", err.code);
      showToast("error", "Error", FRIENDLY.reset(err.code));
    } finally {
      setButtonLoading(forgotSendBtn, forgotSendLabel, false, "", "Send Reset Link");
    }
  });
}

/* ------------------------------------------------ */
/* Boot                                              */
/* ------------------------------------------------ */
/* Expose auth for future logout flows (dashboard) */
window.__retailflowAuth = { auth, signOut };

initLoginPage();
initForgotPassword();

// Future page modules will be initialised here, e.g.:
//   initRegisterPage();
//   initDashboard();