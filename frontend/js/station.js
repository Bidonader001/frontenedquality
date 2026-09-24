const API = "/api/v1";
const STATION_TOKEN = window.STATION_TOKEN || "";
const MONITOR_FRAME_MS = 55;
const MONITOR_FRAME_WIDTH = 640;
const MONITOR_JPEG_QUALITY = 0.65;

let ws = null;
let stream = null;
let active = false;
let rafId = null;
let reconnectTimer = null;
let reconnectDelayMs = 3000;
const RECONNECT_MAX_MS = 30000;

const video = document.getElementById("station-video");
const canvas = document.getElementById("station-canvas");

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${API}/ws/monitor?token=${encodeURIComponent(STATION_TOKEN)}`;
}

function frameToB64(canvasEl, videoEl, maxWidth = 640, quality = 0.65) {
  const ctx = canvasEl.getContext("2d");
  let w = videoEl.videoWidth || 640;
  let h = videoEl.videoHeight || 480;
  if (w > maxWidth) {
    h = Math.round((h * maxWidth) / w);
    w = maxWidth;
  }
  canvasEl.width = w;
  canvasEl.height = h;
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvasEl.toDataURL("image/jpeg", quality);
}

function cameraErrorMessage(err) {
  const name = err?.name || "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera found on this computer. Open this station page on a PC that has a webcam.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied. Click the lock icon in the address bar and Allow camera, then refresh.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Camera is already in use by another app or browser tab. Close that, then refresh.";
  }
  if (name === "SecurityError") {
    return `Camera blocked. Use https://${location.host}/station (not http) and proceed past the certificate warning.`;
  }
  return err?.message || "Could not access camera.";
}

function hasLiveVideo() {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === "live");
}

async function startCamera() {
  // Reconnects reuse a still-live camera instead of opening a second one.
  if (hasLiveVideo()) return;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(`Camera requires HTTPS. Open https://${location.host}/station (not http).`);
  }
  const attempts = [
    { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { facingMode: "user" }, audio: false },
    { video: true, audio: false },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!stream) throw lastError || new Error("Could not access camera.");

  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  await video.play().catch(async () => {
    await new Promise((r) => setTimeout(r, 150));
    await video.play();
  });
}

function pumpFrames(now) {
  if (!active || !ws || ws.readyState !== WebSocket.OPEN) {
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(pumpFrames);
  if (!video.videoWidth) return;
  if (ws.bufferedAmount > 512000) return;
  if (!pumpFrames.last || now - pumpFrames.last >= MONITOR_FRAME_MS) {
    pumpFrames.last = now;
    ws.send(JSON.stringify({ type: "frame", image: frameToB64(canvas, video, MONITOR_FRAME_WIDTH, MONITOR_JPEG_QUALITY) }));
  }
}

function startPump() {
  if (rafId) cancelAnimationFrame(rafId);
  pumpFrames.last = 0;
  rafId = requestAnimationFrame(pumpFrames);
}

function stopPump() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function setUi(data) {
  const name = data.employee_name || data.session_employee_name;
  const employeeEl = document.getElementById("station-employee");
  const hintEl = document.getElementById("station-hint");
  const atPcEl = document.getElementById("station-at-pc");
  const recognized = Boolean(data.identity_verified && name);
  const faceSeen = Boolean(data.face_visible);

  // Presentation only: expose the kiosk state to station.css.
  let uiState = "waiting";
  if (recognized) {
    uiState = data.calibrating ? "calibrating" : "verified";
  } else if (faceSeen) {
    uiState = "unknown";
  }
  if (document.body.dataset.state !== uiState) document.body.dataset.state = uiState;

  if (recognized) {
    employeeEl.textContent = name;
    hintEl.textContent = data.calibrating
      ? "Gaze calibrating — look at your screen for a few seconds."
      : "You are being monitored. Clock-in is automatic.";
  } else if (faceSeen) {
    employeeEl.textContent = "Face not recognized";
    hintEl.textContent =
      "Your face is visible but does not match any enrolled profile. Ask an admin to re-enroll your face in Admin Users.";
  } else {
    employeeEl.textContent = "Waiting for employee…";
    hintEl.textContent = "Look at the camera to be recognized automatically.";
  }

  document.getElementById("station-work").textContent = data.work_label || "—";
  if (atPcEl) {
    if (!faceSeen) {
      atPcEl.textContent = "Not visible";
    } else if (recognized && data.calibrating) {
      atPcEl.textContent = "Calibrating gaze…";
    } else if (recognized) {
      atPcEl.textContent = "Visible at PC";
    } else {
      atPcEl.textContent = "Face visible (not matched)";
    }
  }
  document.getElementById("station-attention").textContent = data.attention || "—";
  document.getElementById("station-phone").textContent = data.phone || "—";
  const phoneDetail = document.getElementById("station-phone-detail");
  if (phoneDetail) phoneDetail.textContent = data.phone_detail || "";
  document.getElementById("station-model").textContent = data.ready
    ? `${data.fps ? `${data.fps} fps` : "Connected"}`
    : data.load_message || "Loading models…";
}

// Single reconnect path with exponential backoff (3s → 30s cap).
function scheduleReconnect(message) {
  if (reconnectTimer) return;
  // Presentation only: if no result has arrived yet, move off "Starting up" so station.css shows "Reconnecting".
  if (!document.body.dataset.state) document.body.dataset.state = "waiting";
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  document.getElementById("station-model").textContent =
    `${message} — reconnecting in ${Math.round(delay / 1000)}s…`;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  if (!STATION_TOKEN || STATION_TOKEN === "__STATION_TOKEN__") {
    const tokenMsg = "Station token missing — restart the server.";
    // Presentation only: no retry happens here, so show a dedicated error state.
    document.body.dataset.state = "error";
    document.getElementById("station-hint").textContent = tokenMsg;
    document.getElementById("station-model").textContent = tokenMsg;
    return;
  }

  const health = await fetch("/health").then((r) => r.json()).catch(() => null);
  if (health?.app) {
    // Product name comes from the server's APP_NAME; the HTML ships the default.
    document.querySelectorAll("[data-app-name]").forEach((el) => {
      el.textContent = health.app;
    });
    document.title = `${health.app} Station · Quality`;
  }
  if (health?.websocket_ready === false) {
    scheduleReconnect(health.hint || "WebSocket not ready");
    return;
  }

  document.getElementById("station-model").textContent = "Starting camera…";
  try {
    await startCamera();
  } catch (err) {
    const msg = cameraErrorMessage(err);
    document.getElementById("station-hint").textContent = msg;
    scheduleReconnect(msg);
    return;
  }

  ws = new WebSocket(wsUrl());
  active = true;

  ws.onopen = () => {
    reconnectDelayMs = 3000;
    document.getElementById("station-live-tag")?.classList.add("visible");
    document.getElementById("station-model").textContent = "Connected — loading models…";
    startPump();
  };

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.type === "result") setUi(data);
    if (data.type === "error") document.getElementById("station-model").textContent = data.message;
  };

  ws.onclose = () => {
    active = false;
    stopPump();
    document.getElementById("station-live-tag")?.classList.remove("visible");
    ws = null;
    scheduleReconnect("Disconnected");
  };

  ws.onerror = () => {
    document.getElementById("station-model").textContent = "Connection error";
  };
}

// Presentation only: kiosk clock (HH:MM), refreshed every 20 s.
function updateStationClock() {
  const clockEl = document.getElementById("station-clock");
  if (!clockEl) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (clockEl.textContent !== hhmm) clockEl.textContent = hhmm;
  clockEl.dateTime = hhmm;
}

updateStationClock();
setInterval(updateStationClock, 20000);

connect();
