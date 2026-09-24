const API = "/api/v1";

const TOKEN_KEY = "qai_token";
// Sessions stored before the rename to Q AI move to the new key instead of being signed out.
const LEGACY_TOKEN_KEY = "whowhat_token";
if (!localStorage.getItem(TOKEN_KEY) && localStorage.getItem(LEGACY_TOKEN_KEY)) {
  localStorage.setItem(TOKEN_KEY, localStorage.getItem(LEGACY_TOKEN_KEY));
}
localStorage.removeItem(LEGACY_TOKEN_KEY);
let authToken = localStorage.getItem(TOKEN_KEY) || "";
// Bumped on sign-out/expiry so a camera request still pending from before cannot switch the webcam on.
let sessionGeneration = 0;
let currentUser = null;

// Escape server strings before putting them into innerHTML templates.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
window.escapeHtml = escapeHtml;

// Up to two uppercase initials for avatar chips ("Sara Adel" -> "SA"). Escape the result before innerHTML.
function personInitials(name) {
  const words = String(name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] || "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
  return (first + last).toUpperCase() || "?";
}
window.personInitials = personInitials;

function setTextById(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Product name: the HTML ships the default, the server's APP_NAME (from /health) overrides it.
let appName = document.querySelector("[data-app-name]")?.textContent.trim() || "Q AI";

function applyAppName(name) {
  if (!name) return;
  appName = name;
  document.querySelectorAll("[data-app-name]").forEach((el) => {
    el.textContent = name;
  });
  document.querySelectorAll("[data-app-name-label]").forEach((el) => {
    el.setAttribute("aria-label", `${el.dataset.appNameLabel} ${name}`);
  });
  document.title = `${name} · Quality`;
}

function appSlug() {
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "q-ai";
}

fetch("/health")
  .then((r) => r.json())
  .then((health) => applyAppName(health?.app))
  .catch(() => {});

// YYYY-MM-DD in the browser's local timezone (toISOString is UTC).
function localIsoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- Camera (single active stream) ---
let loginStream = null;
let adminEnrollStream = null;
let assignerEnrollStream = null;
let monitorStream = null;

function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function cameraErrorMessage(err) {
  const name = err?.name || "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera found on this computer. Use a PC with a webcam.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied. Click the lock icon and Allow camera, then retry.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Camera is already in use by another app or tab.";
  }
  if (!cameraSupported() || name === "SecurityError") {
    return "Camera requires HTTPS. Open this site with https:// and proceed past the certificate warning.";
  }
  return err?.message || "Could not access camera.";
}

function releaseAllCameras() {
  for (const s of [loginStream, adminEnrollStream, assignerEnrollStream, monitorStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  loginStream = null;
  adminEnrollStream = null;
  assignerEnrollStream = null;
  monitorStream = null;
  for (const id of ["login-video", "admin-enroll-video", "assigner-enroll-video", "monitor-video"]) {
    const v = document.getElementById(id);
    if (v) v.srcObject = null;
  }
}

function stopCamera(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

async function startCamera(videoEl, highQuality = false) {
  if (!videoEl) throw new Error("Video element not found");
  if (!cameraSupported()) {
    throw new Error(cameraErrorMessage({ name: "SecurityError" }));
  }

  releaseAllCameras();
  const generation = sessionGeneration;

  const attempts = [
    {
      video: {
        facingMode: "user",
        width: { ideal: highQuality ? 640 : 480 },
        height: { ideal: highQuality ? 480 : 360 },
      },
      audio: false,
    },
    { video: { facingMode: "user" }, audio: false },
    { video: true, audio: false },
  ];

  let stream = null;
  let lastError = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!stream) {
    throw new Error(cameraErrorMessage(lastError || new Error("Could not access camera")));
  }
  if (generation !== sessionGeneration || !authToken) {
    stopCamera(stream);
    throw new Error("Signed out — camera not started.");
  }

  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.srcObject = stream;

  if (videoEl.id === "login-video") loginStream = stream;
  else if (videoEl.id === "admin-enroll-video") adminEnrollStream = stream;
  else if (videoEl.id === "assigner-enroll-video") assignerEnrollStream = stream;
  else if (videoEl.id === "monitor-video") monitorStream = stream;

  try {
    await videoEl.play();
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await videoEl.play();
  }

  return stream;
}

const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");

function setAuth(token, user) {
  authToken = token || "";
  currentUser = user || null;
  window.currentUserRole = currentUser?.role || "";
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function showApp(show) {
  loginScreen.classList.toggle("hidden", show);
  appShell.classList.toggle("hidden", !show);
}

function isAdminUser() {
  return currentUser?.role === "admin";
}

function isAssignerUser() {
  return currentUser?.role === "assigner";
}

function canUseStaffDashboard() {
  return isAdminUser() || isAssignerUser();
}

function applyRoleUi() {
  if (!canUseStaffDashboard()) {
    setAuth("", null);
    showApp(false);
    loginStatus.textContent = "Only administrators and HR enrollment users can sign in here.";
    return;
  }

  document.querySelectorAll(".employee-only").forEach((el) => {
    el.classList.add("hidden");
  });

  const isAdmin = isAdminUser();
  const isAssigner = isAssignerUser();

  document.querySelectorAll(".admin-only").forEach((el) => {
    el.classList.toggle("hidden", !isAdmin);
  });
  document.querySelectorAll(".assigner-only").forEach((el) => {
    el.classList.toggle("hidden", !isAssigner);
  });

  const displayName = currentUser?.username || "—";
  document.getElementById("user-name").textContent = displayName;
  setTextById("user-avatar", personInitials(currentUser?.username || ""));
  document.getElementById("user-role").textContent = isAdmin
    ? "Administrator"
    : isAssigner
      ? "HR enrollment"
      : currentUser?.role || "—";

  updateMonitorSessionBadge();

  setActiveNav(null);
  pages.forEach((p) => p.classList.remove("active"));

  if (isAdmin) {
    const employeesBtn = document.querySelector('.nav-btn[data-page="employees"]');
    if (employeesBtn) {
      setActiveNav(employeesBtn);
      document.getElementById("page-employees")?.classList.add("active");
    }
    loadEmployeesOverview();
  } else {
    const enrollBtn = document.querySelector('.nav-btn[data-page="enroll"]');
    if (enrollBtn) {
      setActiveNav(enrollBtn);
      document.getElementById("page-enroll")?.classList.add("active");
    }
    loadAssignerEmployees();
    setTimeout(() => ensureAssignerEnrollCamera().catch(showAssignerCameraError), 100);
  }
}

async function loadTimesheetStatus() {
  const statusEl = document.getElementById("timesheet-status");
  const btnBreakStart = document.getElementById("btn-break-start");
  const btnBreakEnd = document.getElementById("btn-break-end");
  if (!statusEl || currentUser?.role === "admin") return;
  try {
    const data = await api("/timesheet/status");
    updateTimesheetUi(data);
  } catch (e) {
    statusEl.textContent = e.message;
    if (btnBreakStart) btnBreakStart.disabled = true;
  }
}

function updateTimesheetUi(data) {
  const statusEl = document.getElementById("timesheet-status");
  const btnBreakStart = document.getElementById("btn-break-start");
  const btnBreakEnd = document.getElementById("btn-break-end");
  if (!statusEl) return;

  if (!data.on_shift) {
    statusEl.textContent = "Not clocked in";
    btnBreakStart?.classList.remove("hidden");
    btnBreakEnd?.classList.add("hidden");
    if (btnBreakStart) btnBreakStart.disabled = true;
    if (btnBreakEnd) btnBreakEnd.disabled = true;
    return;
  }

  const shift = data.shift || {};
  const onBreak = data.status === "on_break";
  const breakUsed = Boolean(data.break_used);
  let status =
    `Clocked in ${shift.clock_in_time || "—"}` +
    (onBreak ? " · On break" : "") +
    ` · Work ${formatDurationShort(shift.work_seconds || 0)}` +
    ` · Break ${formatDurationShort(shift.break_seconds || 0)}`;
  if (breakUsed && !onBreak) status += " · Break used";

  statusEl.textContent = status;

  btnBreakStart?.classList.toggle("hidden", onBreak || breakUsed);
  btnBreakEnd?.classList.toggle("hidden", !onBreak);
  if (btnBreakStart) btnBreakStart.disabled = onBreak || breakUsed;
  if (btnBreakEnd) btnBreakEnd.disabled = !onBreak;
}

function formatDurationShort(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

document.getElementById("btn-break-start")?.addEventListener("click", async () => {
  try {
    await api("/timesheet/break-start", { method: "POST" });
    stopPumpFrames();
    monitorActive = false;
    document.getElementById("monitor-hint").textContent = "On break — monitoring paused.";
    await loadTimesheetStatus();
  } catch (e) {
    document.getElementById("timesheet-status").textContent = e.message;
  }
});

document.getElementById("btn-break-end")?.addEventListener("click", async () => {
  try {
    await api("/timesheet/break-end", { method: "POST" });
    document.getElementById("monitor-hint").textContent = "Back from break — resuming monitor…";
    await loadTimesheetStatus();
    ensureMonitorRunning();
  } catch (e) {
    document.getElementById("timesheet-status").textContent = e.message;
  }
});

document.getElementById("btn-clock-out")?.addEventListener("click", async () => {
  if (!confirm("Clock out and end your session?")) return;
  try {
    await api("/timesheet/clock-out", { method: "POST" });
    stopMonitor();
    setAuth("", null);
    showApp(false);
  } catch (e) {
    document.getElementById("timesheet-status").textContent = e.message;
  }
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    onSessionExpired("Session expired — sign in again.");
    const expired = new Error("Session expired — sign in again.");
    expired.status = 401;
    throw expired;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = err.detail;
    const failure = new Error(typeof detail === "string" ? detail : JSON.stringify(err));
    failure.status = res.status;
    throw failure;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

function focusLoginUser() {
  if (!loginScreen?.classList.contains("hidden")) {
    document.getElementById("login-user")?.focus();
  }
}

// Tear down streams, cameras and capture loops, then show login (401 / logout).
function onSessionExpired(message) {
  sessionGeneration += 1;
  stopMonitor();
  stopAdminLiveView();
  stopLogsRealtime();
  releaseAllCameras();
  if (adminGuidedCapture || assignerGuidedCapture) window.speechSynthesis?.cancel();
  adminGuidedCapture = false;
  assignerGuidedCapture = false;
  setEnrollOverlay(false);
  setAssignerEnrollOverlay(false);
  if (btnAdminCapture) {
    btnAdminCapture.disabled = false;
    btnAdminCapture.textContent = "Start guided capture";
  }
  if (btnAssignerCapture) {
    btnAssignerCapture.disabled = false;
    btnAssignerCapture.textContent = "Start guided capture";
  }
  window.DoorLock?.onHide?.();
  setAuth("", null);
  showApp(false);
  if (message && loginStatus) {
    loginStatus.textContent = message;
    loginStatus.classList.add("err");
  }
  focusLoginUser();
}
window.onSessionExpired = onSessionExpired;

async function bootstrapAuth() {
  if (!authToken) {
    showApp(false);
    return;
  }
  try {
    currentUser = await api("/auth/me");
    window.currentUserRole = currentUser?.role || "";
    if (!canUseStaffDashboard()) {
      setAuth("", null);
      showApp(false);
      loginStatus.textContent = "Only administrators and HR enrollment users can sign in here.";
      return;
    }
    showApp(true);
    applyRoleUi();
  } catch (e) {
    showApp(false);
    if (e.status === 401 || e.status === 403) {
      setAuth("", null);
      return;
    }
    // Network / 5xx: keep the token so a refresh can retry.
    loginStatus.textContent = `Could not reach the server (${e.message}). Refresh the page to retry.`;
    loginStatus.classList.add("err");
  }
}

// --- Admin login ---
const loginStatus = document.getElementById("login-status");
const loginForm = document.getElementById("login-form");
const loginSubmitBtn = document.getElementById("btn-login");
let loginBusy = false;

async function submitLogin() {
  if (loginBusy) return;
  const username = document.getElementById("login-user")?.value.trim();
  const password = document.getElementById("login-pass")?.value || "";
  if (!username || !password) {
    loginStatus.textContent = "Enter username and password.";
    loginStatus.classList.add("err");
    return;
  }
  loginBusy = true;
  if (loginSubmitBtn) loginSubmitBtn.disabled = true;
  loginStatus.textContent = "Signing in…";
  loginStatus.classList.remove("err");
  try {
    const data = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || "Login failed");
      }
      return r.json();
    });
    setAuth(data.access_token, {
      username: data.username,
      role: data.role,
      employee_id: data.employee_id,
    });
    currentUser = await api("/auth/me");
    window.currentUserRole = currentUser?.role || "";
    showApp(true);
    applyRoleUi();
    loginStatus.textContent = "";
    loginStatus.classList.remove("err");
  } catch (e) {
    loginStatus.textContent = e.message;
    loginStatus.classList.add("err");
  } finally {
    loginBusy = false;
    if (loginSubmitBtn) loginSubmitBtn.disabled = false;
  }
}

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  submitLogin();
});

document.getElementById("login-user")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("login-pass")?.focus();
  }
});

document.getElementById("btn-logout").addEventListener("click", () => {
  onSessionExpired();
});

// Theme switch: aria-checked is "true" while the light theme is active.
const themeToggle = document.getElementById("btn-theme-toggle");

function syncThemeToggle() {
  if (!themeToggle) return;
  const isLight = document.documentElement.dataset.theme === "light";
  themeToggle.setAttribute("aria-checked", isLight ? "true" : "false");
}

syncThemeToggle();
themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("quality_theme", next);
  } catch {
    /* storage unavailable: the theme still applies to this page */
  }
  syncThemeToggle();
});

const pages = document.querySelectorAll(".page");
const navBtns = document.querySelectorAll(".nav-btn");

// Mark one nav button active (or none when null) and keep aria-current in step.
function setActiveNav(activeBtn) {
  navBtns.forEach((b) => {
    const isActive = b === activeBtn;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

navBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isAssignerUser() && btn.dataset.page !== "enroll") {
      return;
    }
    setActiveNav(btn);
    pages.forEach((p) => p.classList.remove("active"));
    document.getElementById(`page-${btn.dataset.page}`).classList.add("active");
    if (btn.dataset.page === "logs") {
      loadLogs();
      loadEmployeeFilterOptions();
      startLogsRealtime();
    } else {
      stopLogsRealtime();
    }
    if (btn.dataset.page === "reports") loadReports();
    if (btn.dataset.page === "admin") {
      loadUsers();
      setTimeout(() => ensureAdminEnrollCamera().catch(showAdminCameraError), 100);
    }
    if (btn.dataset.page === "employees") loadEmployeesOverview();
    if (btn.dataset.page === "monitor") ensureMonitorRunning();
    if (btn.dataset.page === "door") window.DoorLock?.onShow();
    else window.DoorLock?.onHide();
    if (btn.dataset.page === "enroll") {
      loadAssignerEmployees();
      ensureAssignerEnrollCamera().catch(showAssignerCameraError);
    }
  });
});

function frameToB64(canvas, video, maxWidth = 640, quality = 0.65) {
  const ctx = canvas.getContext("2d");
  let w = video.videoWidth || 640;
  let h = video.videoHeight || 480;
  if (w > maxWidth) {
    h = Math.round((h * maxWidth) / w);
    w = maxWidth;
  }
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopAdminEnrollCamera() {
  if (adminEnrollStream) {
    stopCamera(adminEnrollStream);
    adminEnrollStream = null;
  }
  const video = document.getElementById("admin-enroll-video");
  if (video) video.srcObject = null;
}

function showAdminCameraError(e) {
  const el = document.getElementById("admin-camera-status");
  if (el) el.textContent = `Camera error: ${e.message}. Click Start camera to retry.`;
}

function speakEnrollment(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

const ENROLL_POSES = [
  { id: "center", speak: "Look straight at the camera and hold still.", hint: "Look straight at the camera" },
  { id: "left", speak: "Turn your head slowly to the left.", hint: "Turn your head to the left" },
  { id: "right", speak: "Turn your head slowly to the right.", hint: "Turn your head to the right" },
  { id: "up", speak: "Tilt your head slightly up.", hint: "Tilt your head up" },
  { id: "down", speak: "Tilt your head slightly down.", hint: "Tilt your head down" },
];

let adminGuidedCapture = false;

function setEnrollOverlay(visible, title, step) {
  const overlay = document.getElementById("enroll-overlay");
  const textEl = document.getElementById("enroll-pose-text");
  const stepEl = document.getElementById("enroll-pose-step");
  overlay?.classList.toggle("hidden", !visible);
  if (title && textEl) textEl.textContent = title;
  if (step && stepEl) stepEl.textContent = step;
}

async function captureEnrollmentFace(video, canvas, captures, countEl, statusEl, btnEl, requiredPose = null) {
  if (captures.length >= 5) captures.length = 0;
  if (btnEl && !adminGuidedCapture) btnEl.disabled = true;
  if (statusEl) statusEl.textContent = "Hold still…";

  let best = null;
  for (let i = 0; i < 3; i++) {
    const image = frameToB64(canvas, video, 480, 0.82);
    const payload = { image_b64: image };
    if (requiredPose) payload.required_pose = requiredPose;
    const check = await api("/employees/validate-capture", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (check.ok) {
      best = { image, check };
      break;
    }
    best = { image, check };
    if (i < 2) await sleep(180);
  }

  if (!best?.check.ok) {
    if (statusEl) statusEl.textContent = best?.check.message || "Capture failed. Try again.";
    if (btnEl && !adminGuidedCapture) btnEl.disabled = false;
    return false;
  }

  captures.push(best.image);
  countEl.textContent = `${captures.length} / 5`;
  countEl.classList.toggle("ready", captures.length >= 5);
  if (statusEl) {
    statusEl.textContent =
      captures.length < 5
        ? `Capture ${captures.length} saved.`
        : "5 captures ready.";
  }
  if (btnEl && !adminGuidedCapture) btnEl.disabled = false;
  return true;
}

async function runGuidedEnrollment() {
  if (adminGuidedCapture) {
    adminGuidedCapture = false;
    window.speechSynthesis?.cancel();
    setEnrollOverlay(false);
    if (btnAdminCapture) {
      btnAdminCapture.disabled = false;
      btnAdminCapture.textContent = "Start guided capture";
    }
    if (adminCaptureHint) adminCaptureHint.textContent = "Guided capture stopped.";
    return;
  }

  adminCaptures.length = 0;
  adminCaptureCount.textContent = "0 / 5";
  adminCaptureCount.classList.remove("ready");
  adminGuidedCapture = true;
  if (btnAdminCapture) btnAdminCapture.textContent = "Stop";
  await ensureAdminEnrollCamera();

  for (let i = 0; i < ENROLL_POSES.length; i++) {
    if (!adminGuidedCapture) return;
    const pose = ENROLL_POSES[i];
    setEnrollOverlay(true, pose.hint, `Pose ${i + 1} of 5`);
    adminCaptureHint.textContent = pose.hint;
    speakEnrollment(pose.speak);
    await sleep(500);

    let best = null;
    let darkWarned = false;
    const started = Date.now();
    while (adminGuidedCapture && Date.now() - started < 20000) {
      const image = frameToB64(adminEnrollCanvas, adminEnrollVideo, 480, 0.82);
      let check;
      try {
        check = await api("/employees/validate-capture", {
          method: "POST",
          body: JSON.stringify({ image_b64: image, required_pose: pose.id }),
        });
      } catch (e) {
        adminCaptureHint.textContent = e.message;
        await sleep(200);
        continue;
      }
      if (check.lighting === "dark" && !darkWarned) {
        darkWarned = true;
        speakEnrollment("It is a bit dark. Face a light if you can.");
      }
      if (check.quality_ok && (!best || (check.pose_score || 0) >= (best.check.pose_score || 0))) {
        best = { image, check };
      }
      if (check.ok) {
        adminCaptures.push(image);
        adminCaptureCount.textContent = `${adminCaptures.length} / 5`;
        adminCaptureCount.classList.toggle("ready", adminCaptures.length >= 5);
        speakEnrollment("Got it.");
        setEnrollOverlay(true, "Captured", `Pose ${i + 1} of 5`);
        await sleep(280);
        break;
      }
      const waited = Date.now() - started;
      if (waited > 6000 && best && (best.check.pose_score || 0) >= 0.38) {
        adminCaptures.push(best.image);
        adminCaptureCount.textContent = `${adminCaptures.length} / 5`;
        adminCaptureCount.classList.toggle("ready", adminCaptures.length >= 5);
        speakEnrollment("Got it.");
        setEnrollOverlay(true, "Captured", `Pose ${i + 1} of 5`);
        await sleep(280);
        break;
      }
      adminCaptureHint.textContent = check.message || pose.hint;
      const overlay = document.getElementById("enroll-pose-text");
      if (overlay) overlay.textContent = check.message || pose.hint;
    }
    if (!adminGuidedCapture) return;
    if (adminCaptures.length < i + 1) {
      adminCaptureHint.textContent = `Could not capture "${pose.hint}". Try again.`;
      speakEnrollment("I could not capture that pose. Please try again.");
      adminGuidedCapture = false;
      setEnrollOverlay(false);
      if (btnAdminCapture) {
        btnAdminCapture.disabled = false;
        btnAdminCapture.textContent = "Start guided capture";
      }
      return;
    }
  }

  adminGuidedCapture = false;
  setEnrollOverlay(true, "All 5 poses captured", "Ready to create user");
  adminCaptureHint.textContent = "5 captures ready. Create the employee user.";
  speakEnrollment("All poses captured. You can create the employee now.");
  if (btnAdminCapture) {
    btnAdminCapture.disabled = false;
    btnAdminCapture.textContent = "Start guided capture";
  }
}

// --- Admin users ---
const monitorVideo = document.getElementById("monitor-video");
const monitorCanvas = document.getElementById("monitor-canvas");
const monitorPreview = document.getElementById("monitor-preview");
const btnStart = document.getElementById("btn-start-monitor");
const btnStop = document.getElementById("btn-stop-monitor");
const btnRecalibrate = document.getElementById("btn-recalibrate");
const liveTag = document.getElementById("live-tag");

let ws = null;
let sendTimer = null;
let monitorActive = false;
let monitorRafId = null;
let lastFrameSent = 0;
const MONITOR_FRAME_MS = 55;
const MONITOR_FRAME_WIDTH = 640;
const MONITOR_JPEG_QUALITY = 0.65;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  return `${proto}://${location.host}/api/v1/ws/monitor${q}`;
}

function updateMonitorSessionBadge(extra) {
  const badge = document.getElementById("monitor-session-badge");
  if (!badge) return;
  if (!currentUser?.employee_id) {
    badge.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden", "ok", "bad");
  const name = currentUser.employee_name || currentUser.username;
  if (extra === "mismatch") {
    badge.classList.add("bad");
    badge.textContent = `Wrong person at camera — signed in as ${name} (${currentUser.employee_id})`;
  } else if (extra === "verified") {
    badge.classList.add("ok");
    badge.textContent = `Session linked · ${name} (${currentUser.employee_id}) verified`;
  } else {
    badge.textContent = `Session linked · signed in as ${name} (${currentUser.employee_id})`;
  }
}

function setMonitorUi(data) {
  const workEl = document.getElementById("card-work");
  document.getElementById("val-work").textContent = data.work_label || "—";
  document.getElementById("val-work-detail").textContent = data.work_detail || "";
  workEl.className = "stat-card " + (
    data.work_level === "ok" ? "ok" :
    data.work_level === "bad" ? "bad" : "warn"
  );

  document.getElementById("val-name").textContent =
    data.session_employee_name || data.employee_name || "Unknown";
  const verified = data.identity_verified && !data.identity_mismatch;
  document.getElementById("val-id-conf").textContent = data.identity_mismatch
    ? "Wrong person — must match sign-in"
    : verified
      ? `Verified · ${Math.round((data.face_confidence || 0) * 100)}%`
      : data.session_linked
        ? "Confirming signed-in employee…"
        : "Scanning…";

  if (data.session_linked) {
    updateMonitorSessionBadge(data.identity_mismatch ? "mismatch" : verified ? "verified" : null);
  }

  const identityEl = document.getElementById("card-identity");
  identityEl.className = "stat-card " + (
    data.identity_mismatch ? "bad" : verified ? "ok" : "warn"
  );

  const presenceEl = document.getElementById("card-presence");
  const atPc = Boolean(data.face_visible);
  document.getElementById("val-at-pc").textContent = data.calibrating
    ? "Calibrating…"
    : atPc
      ? "Visible at PC"
      : "Not visible";
  document.getElementById("val-at-pc-detail").textContent = data.calibrating
    ? "Look at your screen"
    : atPc
      ? "Face detected at the desk camera"
      : "Step into camera view";
  presenceEl.className = "stat-card " + (data.calibrating ? "warn" : atPc ? "ok" : "bad");

  const attEl = document.getElementById("card-attention");
  document.getElementById("val-attention").textContent = data.attention || "—";
  document.getElementById("val-attention-detail").textContent = data.attention_detail || "";
  attEl.className = "stat-card " + (
    data.attention_state === "looking_at_screen" ? "ok" :
    data.attention_state === "face_not_detected" ? "bad" : "warn"
  );

  const phEl = document.getElementById("card-phone");
  document.getElementById("val-phone").textContent = data.phone || "—";
  document.getElementById("val-phone-detail").textContent = data.phone_detail || "";
  phEl.className = "stat-card " + (
    data.phone_state === "no_phone" ? "ok" :
    data.phone_state === "on_call" ? "ok" :
    data.phone_state === "phone_in_hand_not_calling" ? "ok" :
    "warn"
  );

  document.getElementById("val-fps").textContent = data.fps ?? "—";
  document.getElementById("val-model-status").textContent = data.ready
    ? (data.calibrating ? `Calibrating ${Math.ceil(data.calibrate_left || 0)}s…` : `Running · ${data.fps || 0} fps`)
    : (data.load_message || "Loading models…");

  const awayEl = document.getElementById("card-session");
  document.getElementById("val-away").textContent =
    data.idle_alert ? `Idle alert · ${(data.away_seconds || 0).toFixed(0)}s away` :
    data.work_compliant ? "On task" :
    data.calibrating ? "Calibrating gaze…" :
    `Away ${(data.away_seconds || 0).toFixed(1)}s`;
  document.getElementById("val-session-detail").textContent =
    data.payroll_recording
      ? "Recording for daily report (verified + sustained)"
      : data.calibrating
        ? "Calibrating — not saved to report yet"
        : data.composite
          ? `State: ${data.composite}`
          : "Waiting for verified identity…";
  awayEl.className = "stat-card " + (data.idle_alert ? "bad" : data.calibrating ? "warn" : "muted");

  if (data.preview_jpeg_b64) {
    // Keep live video feed; skip annotated preview overlay for responsiveness.
  }
}

function pumpFrames(now) {
  if (!monitorActive || !ws || ws.readyState !== WebSocket.OPEN) {
    monitorRafId = null;
    return;
  }
  monitorRafId = requestAnimationFrame(pumpFrames);
  if (!monitorVideo.videoWidth) return;
  if (ws.bufferedAmount > 512000) return; // skip if connection backed up
  if (now - lastFrameSent < MONITOR_FRAME_MS) return;
  lastFrameSent = now;
  try {
    const image = frameToB64(monitorCanvas, monitorVideo, MONITOR_FRAME_WIDTH, MONITOR_JPEG_QUALITY);
    ws.send(JSON.stringify({ type: "frame", image }));
  } catch (e) {
    document.getElementById("val-model-status").textContent = e.message;
  }
}

function startPumpFrames() {
  if (monitorRafId) cancelAnimationFrame(monitorRafId);
  lastFrameSent = 0;
  monitorRafId = requestAnimationFrame(pumpFrames);
}

function stopPumpFrames() {
  if (monitorRafId) {
    cancelAnimationFrame(monitorRafId);
    monitorRafId = null;
  }
}

btnStart.addEventListener("click", () => startMonitor());

async function startMonitor() {
  try {
    if (monitorActive) return;

    stopAdminEnrollCamera();

    const health = await fetch("/health").then((r) => r.json()).catch(() => null);
    if (health && health.websocket_ready === false) {
      document.getElementById("val-model-status").textContent = health.hint || "WebSocket not ready — restart the server.";
      return;
    }

    document.getElementById("val-model-status").textContent = "Starting camera…";
    document.getElementById("monitor-hint").textContent = "Starting live session…";
    monitorPreview.hidden = true;
    monitorVideo.hidden = false;
    await startCamera(monitorVideo, false);
    updateMonitorSessionBadge();

    ws = new WebSocket(wsUrl());
    monitorActive = true;

    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "result") {
        setMonitorUi(data);
        document.getElementById("monitor-hint").textContent = data.calibrating
          ? "Look at your screen for 3 seconds to calibrate gaze."
          : "Live monitor running.";
      }
      if (data.type === "error") {
        document.getElementById("val-model-status").textContent = data.message;
      }
    };

    ws.onopen = () => {
      btnStart.disabled = true;
      btnStop.disabled = false;
      btnRecalibrate.disabled = false;
      liveTag.classList.add("visible");
      document.getElementById("val-model-status").textContent = "Connected — initializing models…";
      startPumpFrames();
    };

    ws.onclose = () => {
      monitorActive = false;
      stopPumpFrames();
      if (sendTimer) clearInterval(sendTimer);
      sendTimer = null;
      liveTag.classList.remove("visible");
      btnStart.disabled = false;
      btnStop.disabled = true;
      btnRecalibrate.disabled = true;
      document.getElementById("val-model-status").textContent = "Disconnected.";
      document.getElementById("monitor-hint").textContent = "Session ended.";
      ws = null;
    };

    ws.onerror = () => {
      document.getElementById("val-model-status").textContent = "WebSocket error — run .\\run-web.bat";
    };
  } catch (e) {
    monitorActive = false;
    document.getElementById("val-model-status").textContent = e.message;
    document.getElementById("monitor-hint").textContent = "Could not start session.";
  }
}

function isMonitorPageActive() {
  return document.getElementById("page-monitor")?.classList.contains("active");
}

function shouldAutoStartMonitor() {
  return false;
}

function ensureMonitorRunning() {
  if (!shouldAutoStartMonitor() || monitorActive) return;
  startMonitor();
}

function stopMonitor() {
  monitorActive = false;
  stopPumpFrames();
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  stopCamera(monitorStream);
  monitorStream = null;
  if (monitorVideo) monitorVideo.srcObject = null;
  monitorPreview.hidden = true;
  liveTag.classList.remove("visible");
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnRecalibrate.disabled = true;
  document.getElementById("monitor-hint").textContent = "Stopped.";
  document.getElementById("val-model-status").textContent = "Stopped";
}

btnStop.addEventListener("click", stopMonitor);

btnRecalibrate.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "recalibrate" }));
  }
});

// --- Logs ---
const logsBody = document.getElementById("logs-body");
const logsEmployeeFilter = document.getElementById("logs-employee-filter");
const logsLiveTag = document.getElementById("logs-live-tag");
let logsWs = null;
let logsReconnectTimer = null;
let logsPollTimer = null;
let latestLogTimestamp = "";
const LOGS_MAX_ROWS = 100;
const LOGS_POLL_MS = 4000;

document.getElementById("btn-refresh-logs").addEventListener("click", loadLogs);
logsEmployeeFilter?.addEventListener("change", () => {
  loadLogs();
  restartLogsRealtime();
});

function isLogsPageActive() {
  return document.getElementById("page-logs")?.classList.contains("active");
}

function shouldStreamLogs() {
  if (!authToken || currentUser?.role !== "admin") return false;
  if (isLogsPageActive()) return true;
  const detail = document.getElementById("employee-detail-card");
  return Boolean(detail && !detail.classList.contains("hidden"));
}

function activeLogsEmployeeFilter() {
  if (isLogsPageActive()) return logsEmployeeFilter?.value || "";
  const detail = document.getElementById("employee-detail-card");
  if (detail && !detail.classList.contains("hidden")) {
    return detail.dataset.employeeId || "";
  }
  return "";
}

function logsWsUrl(employeeId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let q = `?token=${encodeURIComponent(authToken)}`;
  if (employeeId) q += `&employee_id=${encodeURIComponent(employeeId)}`;
  return `${proto}://${location.host}${API}/logs/ws${q}`;
}

function formatLogTs(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso.replace("T", " ").slice(0, 19);
  }
}

function logYesNo(val, fallback = "—") {
  if (val === true || val === "true" || val === "True") return "Yes";
  if (val === false || val === "false" || val === "False") return "No";
  return fallback;
}

function logAtPc(r) {
  return logYesNo(
    r.face_visible,
    r.attention_state === "face_not_detected" ? "No" : r.attention_state ? "Yes" : "—"
  );
}

function logOnScreen(r) {
  const direct = logYesNo(r.on_screen);
  if (direct !== "—") return direct;
  if (r.attention_state === "looking_at_screen") return "Yes";
  if (r.attention_state === "looking_away" || r.attention_state === "face_not_detected") return "No";
  return "—";
}

// Logged states are machine keys; show people the words the live monitor uses.
const LOG_STATE_LABELS = {
  client_call: ["Client call", "pill-ok"],
  client_text: ["Client texting", "pill-ok"],
  multitask: ["Screen + phone", "pill-ok"],
  screen_work: ["Working on screen", "pill-ok"],
  working: ["Working on screen", "pill-ok"],
  phone_nearby: ["Phone nearby", "pill-warn"],
  glance: ["Brief glance away", "pill-warn"],
  distracted: ["Looking away", "pill-warn"],
  no_face: ["Face not visible", "pill-warn"],
  idle: ["Idle", "pill-bad"],
};
const LOG_ATTENTION_LABELS = {
  looking_at_screen: "On screen",
  looking_away: "Looking away",
  face_not_detected: "Not visible",
};
const LOG_PHONE_LABELS = {
  no_phone: "No phone",
  on_call: "On a call",
  phone_in_hand_not_calling: "Phone in hand",
  phone_detected_not_held: "Phone on desk",
};

function logStatePill(state) {
  if (!state) return "—";
  const [label, tone] = LOG_STATE_LABELS[state] || [state, "pill-off"];
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

function logLabel(map, key) {
  return escapeHtml(map[key] || key || "—");
}

function formatLogRow(r, cols = 8) {
  const ts = escapeHtml(formatLogTs(r.timestamp));
  const tsAttr = escapeHtml(r.timestamp || "");
  const atPc = logAtPc(r);
  const onScreen = logOnScreen(r);
  if (cols === 6) {
    return `<tr data-ts="${tsAttr}">
      <td>${ts}</td>
      <td>${logStatePill(r.state)}</td>
      <td>${logLabel(LOG_ATTENTION_LABELS, r.attention_state)}</td>
      <td>${logLabel(LOG_PHONE_LABELS, r.phone_state)}</td>
      <td>${atPc}</td>
      <td>${onScreen}</td>
    </tr>`;
  }
  return `<tr data-ts="${tsAttr}">
    <td>${ts}</td>
    <td>${escapeHtml(r.employee_name || r.employee_id || "—")}</td>
    <td>${logStatePill(r.state)}</td>
    <td>${logLabel(LOG_ATTENTION_LABELS, r.attention_state)}</td>
    <td>${logLabel(LOG_PHONE_LABELS, r.phone_state)}</td>
    <td>${atPc}</td>
    <td>${onScreen}</td>
    <td class="num">${escapeHtml(r.fps || "—")}</td>
  </tr>`;
}

function trackLatestLogTimestamp(ts) {
  if (ts && ts > latestLogTimestamp) latestLogTimestamp = ts;
}

function prependLogRow(r) {
  if (!r?.timestamp) return;
  const filterEmp = isLogsPageActive() ? (logsEmployeeFilter?.value || "") : activeLogsEmployeeFilter();
  if (filterEmp && r.employee_id !== filterEmp) return;
  if (logsBody?.querySelector(`tr[data-ts="${CSS.escape(r.timestamp)}"]`)) return;
  trackLatestLogTimestamp(r.timestamp);

  if (logsBody && isLogsPageActive()) {
    const empty = logsBody.querySelector(".empty-state");
    if (empty) logsBody.innerHTML = "";
    logsBody.insertAdjacentHTML("afterbegin", formatLogRow(r));
    while (logsBody.children.length > LOGS_MAX_ROWS) {
      logsBody.lastElementChild?.remove();
    }
  }

  const detailCard = document.getElementById("employee-detail-card");
  const detailLogs = document.getElementById("detail-logs");
  if (
    detailCard &&
    !detailCard.classList.contains("hidden") &&
    detailCard.dataset.employeeId === r.employee_id &&
    detailLogs
  ) {
    if (detailLogs.querySelector(`tr[data-ts="${CSS.escape(r.timestamp)}"]`)) return;
    const empty = detailLogs.querySelector(".empty-state");
    if (empty) detailLogs.innerHTML = "";
    detailLogs.insertAdjacentHTML("afterbegin", formatLogRow(r, 6));
    while (detailLogs.children.length > LOGS_MAX_ROWS) {
      detailLogs.lastElementChild?.remove();
    }
  }
}

function stopLogsRealtime() {
  if (logsReconnectTimer) {
    clearTimeout(logsReconnectTimer);
    logsReconnectTimer = null;
  }
  if (logsPollTimer) {
    clearInterval(logsPollTimer);
    logsPollTimer = null;
  }
  if (logsWs) {
    logsWs.onclose = null;
    logsWs.close();
    logsWs = null;
  }
  logsLiveTag?.classList.remove("visible");
}

function startLogsRealtime() {
  if (!shouldStreamLogs()) return;
  stopLogsRealtime();
  const emp = activeLogsEmployeeFilter();
  logsWs = new WebSocket(logsWsUrl(emp));

  logsWs.onopen = () => {
    if (isLogsPageActive()) logsLiveTag?.classList.add("visible");
  };

  logsWs.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "log" && data.item) prependLogRow(data.item);
  };

  logsWs.onclose = (ev) => {
    logsLiveTag?.classList.remove("visible");
    // 4401/4403: token rejected — reconnecting would loop forever.
    if (ev.code === 4401 || ev.code === 4403) {
      logsWs = null;
      onSessionExpired("Session expired — sign in again.");
      return;
    }
    if (shouldStreamLogs() && authToken) {
      logsReconnectTimer = setTimeout(startLogsRealtime, 3000);
    }
  };

  logsPollTimer = setInterval(pollLogsSince, LOGS_POLL_MS);
}

async function pollLogsSince() {
  if (!shouldStreamLogs()) return;
  // HTTP poll is only a fallback while the websocket is down.
  if (logsWs && logsWs.readyState === WebSocket.OPEN) return;
  try {
    const emp = activeLogsEmployeeFilter();
    let q = `?limit=30`;
    if (emp) q += `&employee_id=${encodeURIComponent(emp)}`;
    if (latestLogTimestamp) q += `&since=${encodeURIComponent(latestLogTimestamp)}`;
    const { items } = await api(`/logs${q}`);
    for (let i = items.length - 1; i >= 0; i -= 1) prependLogRow(items[i]);
  } catch {
    /* ignore transient poll errors */
  }
}

function restartLogsRealtime() {
  if (shouldStreamLogs()) startLogsRealtime();
  else stopLogsRealtime();
}

async function loadLogs() {
  try {
    const emp = logsEmployeeFilter?.value || "";
    const q = emp ? `?limit=${LOGS_MAX_ROWS}&employee_id=${encodeURIComponent(emp)}` : `?limit=${LOGS_MAX_ROWS}`;
    const { items } = await api(`/logs${q}`);
    latestLogTimestamp = items[0]?.timestamp || "";
    logsBody.innerHTML = items.length
      ? items.map((r) => formatLogRow(r)).join("")
      : '<tr><td colspan="8" class="empty-state">No activity recorded. Start a live session first.</td></tr>';
  } catch (e) {
    logsBody.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`;
  }
}

// --- Reports ---
const reportsBody = document.getElementById("reports-body");
const reportsTimesheetBody = document.getElementById("reports-timesheet-body");
const reportDateInput = document.getElementById("report-date");
reportDateInput.value = localIsoDate();
reportDateInput.addEventListener("change", loadReports);

document.getElementById("btn-generate-report")?.addEventListener("click", async () => {
  const status = document.getElementById("report-status");
  const btn = document.getElementById("btn-generate-report");
  const d = reportDateInput.value;
  if (!d) {
    status.textContent = "Pick a report date first.";
    return;
  }
  btn.disabled = true;
  status.textContent = "Generating PDF…";
  try {
    await api(`/reports/generate/${d}`, { method: "POST" });
    status.textContent = "PDF generated.";
    loadReports();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-download-report")?.addEventListener("click", async () => {
  const status = document.getElementById("report-status");
  const d = reportDateInput.value;
  if (!d) {
    status.textContent = "Pick a report date first.";
    return;
  }
  try {
    const res = await fetch(`${API}/reports/download/${d}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.status === 401) {
      onSessionExpired("Session expired — sign in again.");
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = typeof err.detail === "string" ? err.detail : "";
      if (res.status === 403) throw new Error("You don't have permission to download reports.");
      if (res.status === 400) throw new Error(detail || "Invalid report date.");
      if (res.status === 404) throw new Error(detail || "Report not found — generate it first.");
      throw new Error(detail || `Download failed (${res.status}).`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${appSlug()}-daily-${d}.pdf`;
    a.click();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Download started.";
  } catch (e) {
    status.textContent = e.message;
  }
});

async function loadReports() {
  const status = document.getElementById("report-status");
  try {
    const d = reportDateInput.value;
    const data = await api(`/reports/daily?report_date=${d}`);
    status.textContent = data.generated_at
      ? `PDF last generated ${data.generated_at.replace("T", " ").slice(0, 19)} · Download rebuilds the PDF with latest clock/break data`
      : "No PDF yet for this date — generate or download to create one.";

    if (reportsTimesheetBody) {
      reportsTimesheetBody.innerHTML = (data.timesheet || []).length
        ? data.timesheet
            .map(
              (t) => `<tr>
              <td>${escapeHtml(t.employee_name)} <small>(${escapeHtml(t.employee_id)})</small></td>
              <td>${escapeHtml(t.clock_in)}</td>
              <td>${escapeHtml(t.clock_out)}</td>
              <td class="num">${escapeHtml(t.work_formatted)}</td>
              <td>${escapeHtml(t.break_in)}</td>
              <td>${escapeHtml(t.break_out)}</td>
              <td class="num">${escapeHtml(t.break_formatted)}</td>
            </tr>`
            )
            .join("")
        : '<tr><td colspan="7" class="empty-state">No clock-in / break data for this date.</td></tr>';
    }

    reportsBody.innerHTML = data.employees.length
      ? data.employees
          .map(
            (e) => `<tr class="clickable-row" data-emp-id="${escapeHtml(e.employee_id)}">
              <td><button type="button" class="row-link">${escapeHtml(e.employee_name)}</button> <small>(${escapeHtml(e.employee_id)})</small></td>
              <td class="num">${escapeHtml(e.total_formatted)}</td>
              <td class="num">${escapeHtml(e.screen_formatted)}</td>
              <td class="num">${escapeHtml(e.screen_focus_pct)}%</td>
              <td class="num">${escapeHtml(e.call_formatted)}</td>
              <td class="num">${escapeHtml(e.text_formatted)}</td>
              <td class="num">${escapeHtml(e.at_pc_formatted)}</td>
              <td class="num">${escapeHtml(e.phone_visible_formatted)}</td>
            </tr>`
          )
          .join("")
      : '<tr><td colspan="8" class="empty-state">No activity for this date. Run a live monitor session first.</td></tr>';
    reportsBody.querySelectorAll(".clickable-row").forEach((row) => {
      row.addEventListener("click", () => openEmployeeDetail(row.dataset.empId, reportDateInput.value));
    });
  } catch (e) {
    status.textContent = e.message;
    if (reportsTimesheetBody) {
      reportsTimesheetBody.innerHTML = `<tr><td colspan="7">${escapeHtml(e.message)}</td></tr>`;
    }
    reportsBody.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`;
  }
}

// --- Employees overview (admin) ---
const employeesBody = document.getElementById("employees-body");
const employeesDateInput = document.getElementById("employees-date");
const employeesOverviewCard = document.getElementById("employees-overview-card");
const employeeDetailCard = document.getElementById("employee-detail-card");

if (employeesDateInput) {
  employeesDateInput.value = localIsoDate();
  employeesDateInput.addEventListener("change", loadEmployeesOverview);
}
document.getElementById("btn-refresh-employees")?.addEventListener("click", loadEmployeesOverview);
document.getElementById("btn-close-detail")?.addEventListener("click", () => {
  stopAdminLiveView();
  employeeDetailCard.classList.add("hidden");
  employeesOverviewCard.classList.remove("hidden");
  restartLogsRealtime();
});

let adminViewWs = null;
let adminViewEmployeeId = null;

function adminViewWsUrl(employeeId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = `?token=${encodeURIComponent(authToken)}&employee_id=${encodeURIComponent(employeeId)}`;
  return `${proto}://${location.host}/api/v1/ws/monitor/view${q}`;
}

function stopAdminLiveView() {
  if (adminViewWs) {
    adminViewWs.onclose = null;
    adminViewWs.close();
    adminViewWs = null;
  }
  adminViewEmployeeId = null;
  const img = document.getElementById("admin-live-feed");
  const placeholder = document.getElementById("admin-live-placeholder");
  const tag = document.getElementById("admin-live-tag");
  if (img) {
    img.hidden = true;
    img.removeAttribute("src");
  }
  if (placeholder) placeholder.hidden = false;
  if (tag) tag.classList.remove("visible");
  const btnWatch = document.getElementById("btn-admin-watch-live");
  const btnStop = document.getElementById("btn-admin-stop-live");
  if (btnWatch) btnWatch.disabled = false;
  if (btnStop) btnStop.disabled = true;
}

function setAdminLiveStats(data) {
  const presence = document.getElementById("admin-live-presence");
  const work = document.getElementById("admin-live-work");
  const att = document.getElementById("admin-live-attention");
  const phone = document.getElementById("admin-live-phone");
  const fps = document.getElementById("admin-live-fps");
  if (presence) {
    presence.textContent = data.face_visible ? "Visible at PC" : "Not visible";
  }
  if (work) work.textContent = data.work_label || "—";
  if (att) att.textContent = data.attention || "—";
  if (phone) phone.textContent = data.phone || "—";
  if (fps) fps.textContent = data.fps ? `${data.fps} fps` : "—";
}

function startAdminLiveView(employeeId, employeeName) {
  if (!authToken || currentUser?.role !== "admin") return;
  stopAdminLiveView();
  adminViewEmployeeId = employeeId;

  const img = document.getElementById("admin-live-feed");
  const placeholder = document.getElementById("admin-live-placeholder");
  const hint = document.getElementById("admin-live-hint");
  const tag = document.getElementById("admin-live-tag");
  const btnWatch = document.getElementById("btn-admin-watch-live");
  const btnStop = document.getElementById("btn-admin-stop-live");

  if (hint) hint.textContent = `Connecting to ${employeeName}…`;
  adminViewWs = new WebSocket(adminViewWsUrl(employeeId));

  adminViewWs.onopen = () => {
    if (hint) hint.textContent = `Watching ${employeeName}`;
    if (btnWatch) btnWatch.disabled = true;
    if (btnStop) btnStop.disabled = false;
  };

  adminViewWs.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "error") {
      if (hint) hint.textContent = data.message;
      return;
    }
    if (data.type === "viewer_update") {
      if (data.frame_jpeg_b64 && img) {
        img.src = data.frame_jpeg_b64.startsWith("data:")
          ? data.frame_jpeg_b64
          : `data:image/jpeg;base64,${data.frame_jpeg_b64}`;
        img.hidden = false;
        if (placeholder) placeholder.hidden = true;
        if (tag) tag.classList.add("visible");
      }
      setAdminLiveStats(data);
    }
  };

  adminViewWs.onclose = () => {
    if (adminViewEmployeeId === employeeId) {
      if (hint) hint.textContent = "Live view ended.";
      stopAdminLiveView();
    }
  };

  adminViewWs.onerror = () => {
    if (hint) hint.textContent = "Could not connect to live feed.";
  };
}

document.getElementById("btn-admin-watch-live")?.addEventListener("click", () => {
  const id = document.getElementById("employee-detail-card")?.dataset.employeeId;
  const name = document.getElementById("employee-detail-card")?.dataset.employeeName;
  if (id && name) startAdminLiveView(id, name);
});

document.getElementById("btn-admin-stop-live")?.addEventListener("click", stopAdminLiveView);

async function loadEmployeesOverview() {
  if (!employeesBody) return;
  try {
    const d = employeesDateInput.value;
    const [items, liveData] = await Promise.all([
      api(`/employees/overview?report_date=${d}`),
      api("/monitor/live").catch(() => ({ items: [] })),
    ]);
    const liveMap = Object.fromEntries((liveData.items || []).map((i) => [i.employee_id, i]));

    // KPI strip: enrolled, live now, active today, average screen focus of active rows.
    const activeRows = items.filter((e) => Number(e.total_seconds) > 0);
    const focusSum = activeRows.reduce((sum, e) => sum + (Number(e.screen_focus_pct) || 0), 0);
    setTextById("emp-kpi-enrolled", String(items.length));
    setTextById("emp-kpi-live", String((liveData.items || []).length));
    setTextById("emp-kpi-active", String(activeRows.length));
    setTextById("emp-kpi-focus", activeRows.length ? `${Math.round(focusSum / activeRows.length)}%` : "—");

    employeesBody.innerHTML = items.length
      ? items
          .map(
            (e) => {
              const live = liveMap[e.employee_id];
              let statusPill = e.has_activity
                ? '<span class="pill pill-ok">Active</span>'
                : '<span class="pill pill-off">No activity</span>';
              if (live) {
                statusPill = live.face_visible
                  ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>At PC</span>'
                  : '<span class="pill pill-warn"><span class="dot" aria-hidden="true"></span>Away from PC</span>';
              }
              return `<tr>
              <td>
                <span class="person-cell" style="display:inline-flex;align-items:center;gap:12px">
                  <span class="avatar${live ? " is-live" : ""}" aria-hidden="true">${escapeHtml(personInitials(e.employee_name))}</span>
                  <span>${escapeHtml(e.employee_name)} <small>(${escapeHtml(e.employee_id)})</small></span>
                </span>
              </td>
              <td class="num">${escapeHtml(e.total_formatted)}</td>
              <td class="num">${escapeHtml(e.screen_formatted)}</td>
              <td class="num">${escapeHtml(e.screen_focus_pct)}%</td>
              <td class="num">${escapeHtml(e.call_formatted)}</td>
              <td class="num">${escapeHtml(e.text_formatted)}</td>
              <td>${statusPill}</td>
              <td>
                <button class="ghost view-emp" data-id="${escapeHtml(e.employee_id)}">View</button>
                <button class="ghost del-emp" data-id="${escapeHtml(e.employee_id)}" data-name="${escapeHtml(e.employee_name)}">Delete</button>
                ${
                  live
                    ? `<button class="ghost watch-live" data-id="${escapeHtml(e.employee_id)}">Watch live</button>`
                    : ""
                }
              </td>
            </tr>`;
            }
          )
          .join("")
      : '<tr><td colspan="8" class="empty-state">No employees yet. Add employees in Admin users.</td></tr>';
    employeesBody.querySelectorAll(".view-emp").forEach((btn) => {
      btn.addEventListener("click", () => openEmployeeDetail(btn.dataset.id, employeesDateInput.value));
    });
    employeesBody.querySelectorAll(".del-emp").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name || btn.dataset.id;
        if (
          !confirm(
            `Delete ${name} from the whole system?\nThis removes their face, login, activity, shifts, and logs.`
          )
        ) {
          return;
        }
        try {
          await api(`/employees/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
          loadEmployeesOverview();
          loadUsers();
          loadEmployeeFilterOptions();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    employeesBody.querySelectorAll(".watch-live").forEach((btn) => {
      btn.addEventListener("click", () =>
        openEmployeeDetail(btn.dataset.id, employeesDateInput.value, { autoWatch: true })
      );
    });
  } catch (e) {
    for (const id of ["emp-kpi-enrolled", "emp-kpi-live", "emp-kpi-active", "emp-kpi-focus"]) {
      setTextById(id, "—");
    }
    employeesBody.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`;
  }
}

async function openEmployeeDetail(employeeId, reportDate, options = {}) {
  if (!employeeDetailCard || !employeesOverviewCard) return;

  const navEmployees = document.querySelector('.nav-btn[data-page="employees"]');
  if (navEmployees && currentUser?.role === "admin") {
    setActiveNav(navEmployees);
    pages.forEach((p) => p.classList.remove("active"));
    document.getElementById("page-employees").classList.add("active");
  }

  stopAdminLiveView();

  try {
    const d = reportDate || employeesDateInput?.value || localIsoDate();
    const [profile, liveData] = await Promise.all([
      api(`/employees/${encodeURIComponent(employeeId)}/profile?report_date=${d}`),
      api("/monitor/live").catch(() => ({ items: [] })),
    ]);
    const s = profile.stats;
    const isLive = (liveData.items || []).some((i) => i.employee_id === employeeId);

    employeeDetailCard.dataset.employeeId = profile.employee_id;
    employeeDetailCard.dataset.employeeName = profile.name;

    document.getElementById("detail-title").textContent = `${profile.name} (${profile.employee_id})`;
    document.getElementById("detail-subtitle").textContent = `Performance for ${d} · enrolled ${profile.created_at.slice(0, 10)}`;
    document.getElementById("detail-total").textContent = s.total_formatted;
    document.getElementById("detail-screen").textContent = s.screen_formatted;
    document.getElementById("detail-screen-pct").textContent = `${s.screen_focus_pct}% screen focus`;
    document.getElementById("detail-call").textContent = s.call_formatted;
    document.getElementById("detail-text").textContent = s.text_formatted;
    document.getElementById("detail-phone").textContent = s.phone_visible_formatted;
    document.getElementById("detail-away").textContent = formatDurationShort(s.away_seconds);
    document.getElementById("detail-at-pc").textContent = s.at_pc_formatted;
    const atPcPct = s.total_seconds > 0
      ? Math.round((s.at_pc_seconds / s.total_seconds) * 100)
      : 0;
    document.getElementById("detail-at-pc-pct").textContent = `${atPcPct}% visible at desk`;

    const historyBody = document.getElementById("detail-history");
    historyBody.innerHTML = profile.history.length
      ? profile.history
          .map(
            (h) => `<tr>
              <td>${escapeHtml(h.activity_date)}</td>
              <td class="num">${escapeHtml(h.total_formatted)}</td>
              <td class="num">${escapeHtml(h.screen_formatted)}</td>
              <td class="num">${escapeHtml(h.screen_focus_pct)}%</td>
              <td class="num">${formatDurationShort(h.call_seconds)}</td>
              <td class="num">${formatDurationShort(h.text_seconds)}</td>
            </tr>`
          )
          .join("")
      : '<tr><td colspan="6" class="empty-state">No history yet.</td></tr>';

    const logsBodyEl = document.getElementById("detail-logs");
    logsBodyEl.innerHTML = profile.recent_logs.length
      ? profile.recent_logs.map((r) => formatLogRow(r, 6)).join("")
      : '<tr><td colspan="6" class="empty-state">No events for this employee yet.</td></tr>';

    employeesOverviewCard.classList.add("hidden");
    employeeDetailCard.classList.remove("hidden");

    const watchBtn = document.getElementById("btn-admin-watch-live");
    const liveHint = document.getElementById("admin-live-hint");
    if (watchBtn) watchBtn.disabled = !isLive;
    if (liveHint) {
      liveHint.textContent = isLive
        ? "Employee is live — click Watch live to view their camera."
        : "Employee is not live right now (must be signed in with monitor running).";
    }
    if (options.autoWatch && isLive) {
      startAdminLiveView(profile.employee_id, profile.name);
    }
    startLogsRealtime();
  } catch (e) {
    alert(e.message);
  }
}

function formatDurationShort(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return "0m";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// --- Admin users ---
const usersList = document.getElementById("users-list");
const adminEnrollVideo = document.getElementById("admin-enroll-video");
const adminEnrollCanvas = document.getElementById("admin-enroll-canvas");
const adminCaptureCount = document.getElementById("admin-capture-count");
const adminCaptureHint = document.getElementById("admin-capture-hint");
const btnAdminCapture = document.getElementById("btn-admin-capture");
const employeeFields = document.getElementById("employee-fields");
const newRoleSelect = document.getElementById("new-role");
const adminCaptures = [];
let reEnrollEmployeeId = null;
let reEnrollEmployeeName = null;

function enrollRoleNeedsFace(role) {
  return role === "employee" || role === "manager";
}

function clearReEnrollTarget() {
  reEnrollEmployeeId = null;
  reEnrollEmployeeName = null;
  const banner = document.getElementById("re-enroll-banner");
  if (banner) banner.classList.add("hidden");
  const createBtn = document.getElementById("btn-create-user");
  if (createBtn) createBtn.textContent = "Create user";
}

async function startReEnroll(employeeId, employeeName) {
  reEnrollEmployeeId = employeeId;
  reEnrollEmployeeName = employeeName;
  const idInput = document.getElementById("new-employee-id");
  const nameInput = document.getElementById("new-full-name");
  if (idInput) idInput.value = employeeId;
  if (nameInput) nameInput.value = employeeName;
  try {
    const employees = await api("/employees");
    const emp = employees.find((e) => e.employee_id === employeeId);
    if (newRoleSelect) {
      newRoleSelect.value = emp?.is_manager ? "manager" : "employee";
      toggleEmployeeFields();
    }
  } catch {
    // Lookup failed: keep current role unless it can't carry a face.
    if (newRoleSelect && !enrollRoleNeedsFace(newRoleSelect.value)) newRoleSelect.value = "employee";
    toggleEmployeeFields();
  }
  adminCaptures.length = 0;
  adminCaptureCount.textContent = "0 / 5";
  adminCaptureCount.classList.remove("ready");
  const banner = document.getElementById("re-enroll-banner");
  if (banner) {
    banner.textContent = `Re-enrolling face for ${employeeName} (${employeeId}). Capture 5 poses, then click Save re-enrollment.`;
    banner.classList.remove("hidden");
  }
  const createBtn = document.getElementById("btn-create-user");
  if (createBtn) createBtn.textContent = "Save re-enrollment";
  document.querySelector('[data-page="admin"]')?.click();
  document.getElementById("admin-status").textContent =
    `Re-enroll ${employeeName}: start guided capture below.`;
  setTimeout(() => ensureAdminEnrollCamera().catch(showAdminCameraError), 150);
}

async function submitReEnroll() {
  const status = document.getElementById("admin-status");
  if (!reEnrollEmployeeId || adminCaptures.length < 5) {
    status.textContent = "Capture 5 face images before saving re-enrollment.";
    return;
  }
  status.textContent = "Saving new face profile…";
  try {
    await api(`/employees/${encodeURIComponent(reEnrollEmployeeId)}/enroll`, {
      method: "PUT",
      body: JSON.stringify({
        images_b64: adminCaptures,
        name: reEnrollEmployeeName || undefined,
        role: newRoleSelect?.value === "manager" ? "manager" : "employee",
      }),
    });
    status.textContent = `Face re-enrolled for ${reEnrollEmployeeName || reEnrollEmployeeId}. Refresh the station page.`;
    adminCaptures.length = 0;
    adminCaptureCount.textContent = "0 / 5";
    adminCaptureCount.classList.remove("ready");
    setEnrollOverlay(false);
    clearReEnrollTarget();
    loadEmployeesOverview();
  } catch (e) {
    status.textContent = e.message;
  }
}

function toggleEmployeeFields() {
  const role = newRoleSelect?.value || "employee";
  const needsFace = enrollRoleNeedsFace(role);
  employeeFields?.classList.toggle("hidden", !needsFace);
  const createBtn = document.getElementById("btn-create-user");
  if (createBtn && !reEnrollEmployeeId) {
    if (role === "assigner") createBtn.textContent = "Create HR user";
    else if (role === "manager") createBtn.textContent = "Create manager";
    else if (role === "employee") createBtn.textContent = "Create employee";
    else createBtn.textContent = "Create user";
  }
}

newRoleSelect?.addEventListener("change", () => {
  toggleEmployeeFields();
  if (enrollRoleNeedsFace(newRoleSelect.value)) {
    setTimeout(() => ensureAdminEnrollCamera().catch(showAdminCameraError), 100);
  }
});

async function ensureAdminEnrollCamera() {
  if (!adminEnrollVideo || !authToken) return;
  const statusEl = document.getElementById("admin-camera-status");
  if (monitorActive) stopMonitor();

  if (statusEl) statusEl.textContent = "Starting camera…";
  await startCamera(adminEnrollVideo, true);
  if (statusEl) statusEl.textContent = "Camera ready — start guided capture for 5 poses.";
}

document.getElementById("btn-admin-start-camera")?.addEventListener("click", () => {
  ensureAdminEnrollCamera().catch(showAdminCameraError);
});

btnAdminCapture?.addEventListener("click", async () => {
  try {
    await runGuidedEnrollment();
  } catch (e) {
    adminGuidedCapture = false;
    setEnrollOverlay(false);
    if (btnAdminCapture) {
      btnAdminCapture.disabled = false;
      btnAdminCapture.textContent = "Start guided capture";
    }
    adminCaptureHint.textContent = e.message;
  }
});

document.getElementById("btn-create-user")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-create-user");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await createUserOrReEnroll();
  } finally {
    btn.disabled = false;
  }
});

async function createUserOrReEnroll() {
  const status = document.getElementById("admin-status");
  if (reEnrollEmployeeId) {
    await submitReEnroll();
    return;
  }
  const role = newRoleSelect.value;
  if (enrollRoleNeedsFace(role) && adminCaptures.length < 5) {
    status.textContent = "Capture 5 face images before saving.";
    return;
  }
  status.textContent = "Creating…";
  try {
    const payload = {
      username: document.getElementById("new-username").value.trim(),
      password: document.getElementById("new-password").value,
      role,
      employee_id: document.getElementById("new-employee-id").value.trim() || null,
      name: document.getElementById("new-full-name").value.trim() || null,
      images_b64: enrollRoleNeedsFace(role) ? adminCaptures : [],
    };
    const created = await api("/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    document.getElementById("new-username").value = "";
    document.getElementById("new-password").value = "";
    document.getElementById("new-employee-id").value = "";
    document.getElementById("new-full-name").value = "";
    if (newRoleSelect) newRoleSelect.value = "employee";
    toggleEmployeeFields();
    adminCaptures.length = 0;
    adminCaptureCount.textContent = "0 / 5";
    adminCaptureCount.classList.remove("ready");
    adminCaptureHint.textContent = "The camera will speak instructions and capture 5 poses automatically.";
    setEnrollOverlay(false);
    status.textContent = created.employee_name
      ? `User created and ${created.employee_name} enrolled for attendance and door access.`
      : "User created.";
    loadUsers();
    loadEmployeesOverview();
  } catch (e) {
    status.textContent = e.message;
  }
}

toggleEmployeeFields();

async function loadEmployeeFilterOptions() {
  try {
    const items = await api("/employees");
    const options = items
      .map((e) => `<option value="${escapeHtml(e.employee_id)}">${escapeHtml(e.name)} (${escapeHtml(e.employee_id)})</option>`)
      .join("");
    const logsFilter = document.getElementById("logs-employee-filter");
    if (logsFilter) {
      const current = logsFilter.value;
      logsFilter.innerHTML = `<option value="">All employees</option>${options}`;
      logsFilter.value = current;
    }
  } catch {
    /* ignore */
  }
}

async function loadUsers() {
  try {
    const items = await api("/admin/users");
    usersList.innerHTML = items.length
      ? items
          .map(
            (u) =>
              `<li class="person-card">
               <span class="avatar" aria-hidden="true">${escapeHtml(personInitials(u.employee_name || u.username))}</span>
               <div style="flex:1;min-width:0">
                 <strong>${escapeHtml(u.username)}</strong>
                 <small>${escapeHtml(u.role)}${u.employee_id ? ` · ${escapeHtml(u.employee_id)}` : ""}${u.employee_name ? ` · ${escapeHtml(u.employee_name)}` : ""}</small>
               </div>
               <span class="user-actions">
               ${u.employee_id ? `<button type="button" data-employee-id="${escapeHtml(u.employee_id)}" data-employee-name="${escapeHtml(u.employee_name || u.username)}" class="ghost small re-enroll-user">Re-enroll face</button>` : ""}
               <button data-id="${escapeHtml(u.id)}" data-employee-id="${escapeHtml(u.employee_id || "")}" data-name="${escapeHtml(u.username)}" class="ghost small del-user">Remove</button>
               </span></li>`
          )
          .join("")
      : '<li class="empty-state">No users yet.</li>';
    usersList.querySelectorAll(".re-enroll-user").forEach((btn) => {
      btn.addEventListener("click", () => {
        startReEnroll(btn.dataset.employeeId, btn.dataset.employeeName || btn.dataset.employeeId).catch(
          () => {}
        );
      });
    });
    usersList.querySelectorAll(".del-user").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const who = btn.dataset.name || "this user";
        const emp = btn.dataset.employeeId;
        const extra = emp
          ? `\nThis also deletes employee ${emp} from the database (face, activity, logs).`
          : "";
        if (!confirm(`Remove ${who} from Admin users?${extra}`)) return;
        const status = document.getElementById("admin-status");
        try {
          const empId = (btn.dataset.employeeId || "").trim();
          const q = empId ? `?employee_id=${encodeURIComponent(empId)}` : "";
          const result = await api(`/admin/users/${btn.dataset.id}${q}`, { method: "DELETE" });
          if (status) {
            status.textContent = result.purged_employee
              ? `Removed ${result.username} and employee ${result.employee_id} from the database.`
              : `Removed ${result.username || who}.`;
          }
          await loadUsers();
          await loadEmployeesOverview();
          await loadEmployeeFilterOptions();
        } catch (err) {
          if (status) status.textContent = err.message;
        }
      });
    });
  } catch (e) {
    usersList.innerHTML = `<li>${escapeHtml(e.message)}</li>`;
  }
}

// --- HR assigner: enroll employees ---
const assignerEnrollVideo = document.getElementById("assigner-enroll-video");
const assignerEnrollCanvas = document.getElementById("assigner-enroll-canvas");
const assignerCaptureCount = document.getElementById("assigner-capture-count");
const assignerCaptureHint = document.getElementById("assigner-capture-hint");
const btnAssignerCapture = document.getElementById("btn-assigner-capture");
const assignerCaptures = [];
let assignerGuidedCapture = false;
let assignerReEnrollId = null;

function setAssignerEnrollOverlay(visible, title, step) {
  const overlay = document.getElementById("assigner-enroll-overlay");
  const textEl = document.getElementById("assigner-enroll-pose-text");
  const stepEl = document.getElementById("assigner-enroll-pose-step");
  overlay?.classList.toggle("hidden", !visible);
  if (title && textEl) textEl.textContent = title;
  if (step && stepEl) stepEl.textContent = step;
}

function showAssignerCameraError(e) {
  const el = document.getElementById("assigner-camera-status");
  if (el) el.textContent = `Camera error: ${e.message}. Click Start camera to retry.`;
}

async function ensureAssignerEnrollCamera() {
  if (!assignerEnrollVideo || !authToken) return;
  const statusEl = document.getElementById("assigner-camera-status");
  if (monitorActive) stopMonitor();
  if (statusEl) statusEl.textContent = "Starting camera…";
  await startCamera(assignerEnrollVideo, true);
  if (statusEl) statusEl.textContent = "Camera ready — start guided capture for 5 poses.";
}

async function runAssignerGuidedEnrollment() {
  if (assignerGuidedCapture) {
    assignerGuidedCapture = false;
    window.speechSynthesis?.cancel();
    setAssignerEnrollOverlay(false);
    if (btnAssignerCapture) {
      btnAssignerCapture.disabled = false;
      btnAssignerCapture.textContent = "Start guided capture";
    }
    if (assignerCaptureHint) assignerCaptureHint.textContent = "Guided capture stopped.";
    return;
  }

  assignerCaptures.length = 0;
  assignerCaptureCount.textContent = "0 / 5";
  assignerCaptureCount.classList.remove("ready");
  assignerGuidedCapture = true;
  if (btnAssignerCapture) btnAssignerCapture.textContent = "Stop";
  await ensureAssignerEnrollCamera();

  for (let i = 0; i < ENROLL_POSES.length; i++) {
    if (!assignerGuidedCapture) return;
    const pose = ENROLL_POSES[i];
    setAssignerEnrollOverlay(true, pose.hint, `Pose ${i + 1} of 5`);
    assignerCaptureHint.textContent = pose.hint;
    speakEnrollment(pose.speak);
    await sleep(500);

    let best = null;
    let darkWarned = false;
    const started = Date.now();
    while (assignerGuidedCapture && Date.now() - started < 20000) {
      const image = frameToB64(assignerEnrollCanvas, assignerEnrollVideo, 480, 0.82);
      let check;
      try {
        check = await api("/employees/validate-capture", {
          method: "POST",
          body: JSON.stringify({ image_b64: image, required_pose: pose.id }),
        });
      } catch (e) {
        assignerCaptureHint.textContent = e.message;
        await sleep(200);
        continue;
      }
      if (check.lighting === "dark" && !darkWarned) {
        darkWarned = true;
        speakEnrollment("It is a bit dark. Face a light if you can.");
      }
      if (check.quality_ok && (!best || (check.pose_score || 0) >= (best.check.pose_score || 0))) {
        best = { image, check };
      }
      if (check.ok) {
        assignerCaptures.push(image);
        assignerCaptureCount.textContent = `${assignerCaptures.length} / 5`;
        assignerCaptureCount.classList.toggle("ready", assignerCaptures.length >= 5);
        speakEnrollment("Got it.");
        setAssignerEnrollOverlay(true, "Captured", `Pose ${i + 1} of 5`);
        await sleep(280);
        break;
      }
      const waited = Date.now() - started;
      if (waited > 6000 && best && (best.check.pose_score || 0) >= 0.38) {
        assignerCaptures.push(best.image);
        assignerCaptureCount.textContent = `${assignerCaptures.length} / 5`;
        assignerCaptureCount.classList.toggle("ready", assignerCaptures.length >= 5);
        speakEnrollment("Got it.");
        setAssignerEnrollOverlay(true, "Captured", `Pose ${i + 1} of 5`);
        await sleep(280);
        break;
      }
      assignerCaptureHint.textContent = check.message || pose.hint;
      const overlay = document.getElementById("assigner-enroll-pose-text");
      if (overlay) overlay.textContent = check.message || pose.hint;
    }
    if (!assignerGuidedCapture) return;
    if (assignerCaptures.length < i + 1) {
      assignerCaptureHint.textContent = `Could not capture "${pose.hint}". Try again.`;
      speakEnrollment("I could not capture that pose. Please try again.");
      assignerGuidedCapture = false;
      setAssignerEnrollOverlay(false);
      if (btnAssignerCapture) {
        btnAssignerCapture.disabled = false;
        btnAssignerCapture.textContent = "Start guided capture";
      }
      return;
    }
  }

  assignerGuidedCapture = false;
  setAssignerEnrollOverlay(true, "All 5 poses captured", "Ready to save");
  assignerCaptureHint.textContent = "5 captures ready. Click Save employee.";
  speakEnrollment("All poses captured. You can save the employee now.");
  if (btnAssignerCapture) {
    btnAssignerCapture.disabled = false;
    btnAssignerCapture.textContent = "Start guided capture";
  }
}

async function submitAssignerEnroll() {
  const statusEl = document.getElementById("assigner-enroll-status");
  const employeeId = document.getElementById("assigner-employee-id")?.value.trim();
  const name = document.getElementById("assigner-full-name")?.value.trim();
  if (assignerCaptures.length < 5) {
    statusEl.textContent = "Capture 5 face images before saving.";
    return;
  }
  if (!employeeId || !name) {
    statusEl.textContent = "Employee ID and full name are required.";
    return;
  }
  statusEl.textContent = assignerReEnrollId ? "Updating face profile…" : "Saving employee…";
  try {
    if (assignerReEnrollId) {
      await api(`/employees/${encodeURIComponent(assignerReEnrollId)}/enroll`, {
        method: "PUT",
        body: JSON.stringify({
          images_b64: assignerCaptures,
          name,
          role: document.getElementById("assigner-enroll-role")?.value || "employee",
        }),
      });
      statusEl.textContent = `Updated face for ${name} (${assignerReEnrollId}).`;
    } else {
      await api("/employees/enroll", {
        method: "POST",
        body: JSON.stringify({
          employee_id: employeeId,
          name,
          images_b64: assignerCaptures,
          role: document.getElementById("assigner-enroll-role")?.value || "employee",
        }),
      });
      const roleLabel =
        document.getElementById("assigner-enroll-role")?.value === "manager" ? "Manager" : "Employee";
      statusEl.textContent = `Enrolled ${name} (${employeeId}) as ${roleLabel}.`;
    }
    assignerCaptures.length = 0;
    assignerCaptureCount.textContent = "0 / 5";
    assignerCaptureCount.classList.remove("ready");
    assignerReEnrollId = null;
    setAssignerEnrollOverlay(false);
    document.getElementById("assigner-employee-id").disabled = false;
    document.getElementById("assigner-employee-id").value = "";
    document.getElementById("assigner-full-name").value = "";
    const assignerRole = document.getElementById("assigner-enroll-role");
    if (assignerRole) assignerRole.value = "employee";
    document.getElementById("btn-assigner-enroll").textContent = "Save employee";
    await loadAssignerEmployees();
  } catch (e) {
    statusEl.textContent = e.message;
  }
}

async function loadAssignerEmployees() {
  const list = document.getElementById("assigner-employees-list");
  if (!list) return;
  try {
    const employees = await api("/employees");
    list.innerHTML = employees.length
      ? employees
          .map(
            (e) => `<div class="person-card">
              <span class="avatar" aria-hidden="true">${escapeHtml(personInitials(e.name))}</span>
              <div style="flex:1;min-width:0">
                <strong>${escapeHtml(e.name)}</strong>
                <small>${escapeHtml(e.employee_id)} · ${
                  e.employee_type === "manager" || e.is_manager ? "Manager" : "Employee"
                } · enrolled ${escapeHtml(e.created_at.slice(0, 10))}</small>
              </div>
              ${
                e.is_manager || e.door_authorized
                  ? '<small class="status dim">Door access — an administrator re-captures this face</small>'
                  : `<button type="button" class="ghost small assigner-re-enroll" data-id="${escapeHtml(e.employee_id)}" data-name="${escapeHtml(e.name)}" data-manager="0">Re-capture face</button>`
              }
            </div>`
          )
          .join("")
      : '<p class="status dim">No employees enrolled yet.</p>';
    list.querySelectorAll(".assigner-re-enroll").forEach((btn) => {
      btn.addEventListener("click", () => {
        assignerReEnrollId = btn.dataset.id;
        document.getElementById("assigner-employee-id").value = btn.dataset.id;
        document.getElementById("assigner-employee-id").disabled = true;
        document.getElementById("assigner-full-name").value = btn.dataset.name;
        const assignerRole = document.getElementById("assigner-enroll-role");
        if (assignerRole) assignerRole.value = btn.dataset.manager === "1" ? "manager" : "employee";
        document.getElementById("btn-assigner-enroll").textContent = "Save updated face";
        document.getElementById("assigner-enroll-status").textContent =
          `Re-capture 5 poses for ${btn.dataset.name}, then save.`;
        assignerCaptures.length = 0;
        assignerCaptureCount.textContent = "0 / 5";
        assignerCaptureCount.classList.remove("ready");
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="status dim">${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById("btn-assigner-start-camera")?.addEventListener("click", () => {
  ensureAssignerEnrollCamera().catch(showAssignerCameraError);
});

btnAssignerCapture?.addEventListener("click", () => {
  runAssignerGuidedEnrollment().catch((e) => {
    assignerGuidedCapture = false;
    setAssignerEnrollOverlay(false);
    if (btnAssignerCapture) {
      btnAssignerCapture.disabled = false;
      btnAssignerCapture.textContent = "Start guided capture";
    }
    assignerCaptureHint.textContent = e.message;
  });
});

document.getElementById("btn-assigner-enroll")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-assigner-enroll");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await submitAssignerEnroll();
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("btn-assigner-refresh-list")?.addEventListener("click", loadAssignerEmployees);

document.getElementById("assigner-employee-id")?.addEventListener("input", () => {
  if (!assignerReEnrollId) return;
  assignerReEnrollId = null;
  document.getElementById("assigner-employee-id").disabled = false;
  document.getElementById("btn-assigner-enroll").textContent = "Save employee";
});

// Init
bootstrapAuth().finally(focusLoginUser);
// Don't grab the camera on load — only when user opens Enroll or Monitor.
