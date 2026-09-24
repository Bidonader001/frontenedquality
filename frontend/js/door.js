let doorStatusTimer = null;
let streamActive = false;
let scannerActive = false;
let lastHighlightSeq = null;
let cameraConfigured = false;

// scan-result is a read-only status read; the server scanner decides unlocks.
const SCAN_POLL_MS = 250;
let autoUnlockLive = null;
let doorPageVisible = false;

// Shared helper from app.js; fallback in case a stale cached app.js is served.
const doorEscapeHtml =
  window.escapeHtml ||
  ((value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;"));

// Avatar initials helper from app.js, with the same stale-cache fallback. Escape the result before innerHTML.
const doorInitials =
  window.personInitials ||
  ((name) => {
    const words = String(name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return "?";
    const first = Array.from(words[0])[0] || "";
    const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
    return (first + last).toUpperCase() || "?";
  });

function setCameraConfigStatus(text, kind) {
  const el = document.getElementById("camera-config-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind === "ok") el.classList.add("ok");
  if (kind === "err") el.classList.add("err");
}

async function loadCameraConfig() {
  const hostEl = document.getElementById("camera-host");
  const userEl = document.getElementById("camera-username");
  const pathEl = document.getElementById("camera-snapshot-path");
  const passEl = document.getElementById("camera-password");
  if (!hostEl) return;

  try {
    const cfg = await doorApi("/camera/config");
    cameraConfigured = !!cfg.configured;
    hostEl.value = cfg.host || "";
    if (userEl) userEl.value = cfg.username || "";
    if (pathEl) pathEl.value = cfg.snapshot_path || "/cgi-bin/snapshot.cgi";
    if (passEl) passEl.value = "";
    if (passEl) {
      passEl.placeholder = cfg.password_set
        ? "Leave blank to keep saved password"
        : "Enter camera password";
    }
    if (!cfg.configured) {
      setCameraConfigStatus("Camera not configured yet. Add IP, username, and password, then save.", "err");
    } else if (cfg.password_set) {
      setCameraConfigStatus(`Saved for ${cfg.host}. Password is stored on the server.`, "ok");
    } else {
      setCameraConfigStatus(`Saved for ${cfg.host}, but password is missing.`, "err");
    }
  } catch (e) {
    cameraConfigured = false;
    setCameraConfigStatus(e.message, "err");
  }
}

async function saveCameraConfig() {
  const host = document.getElementById("camera-host")?.value.trim();
  const username = document.getElementById("camera-username")?.value.trim();
  const password = document.getElementById("camera-password")?.value || "";
  const snapshotPath = document.getElementById("camera-snapshot-path")?.value.trim();
  if (!host || !username) {
    setCameraConfigStatus("Camera IP and username are required.", "err");
    return;
  }
  setCameraConfigStatus("Saving camera settings…");
  try {
    const cfg = await doorApi("/camera/config", {
      method: "PUT",
      body: JSON.stringify({
        host,
        username,
        password,
        snapshot_path: snapshotPath || null,
      }),
    });
    cameraConfigured = !!cfg.configured;
    const passEl = document.getElementById("camera-password");
    if (passEl) {
      passEl.value = "";
      passEl.placeholder = cfg.password_set
        ? "Leave blank to keep saved password"
        : "Enter camera password";
    }
    setCameraConfigStatus(`Camera saved for ${cfg.host}.`, "ok");
    stopLiveStream();
  } catch (e) {
    setCameraConfigStatus(e.message, "err");
  }
}

async function testCameraConfig() {
  setCameraConfigStatus("Testing camera connection…");
  try {
    const result = await doorApi("/camera/config/test", { method: "POST", body: "{}" });
    setCameraConfigStatus(result.message || "Camera connected successfully.", "ok");
    cameraConfigured = true;
    startLiveStream();
  } catch (e) {
    setCameraConfigStatus(e.message, "err");
  }
}

function requireCameraConfigured(actionLabel) {
  if (cameraConfigured) return true;
  setCameraConfigStatus(`Configure the door camera first (${actionLabel}).`, "err");
  const statusEl = document.getElementById("camera-status");
  if (statusEl) statusEl.textContent = "Configure the door camera above before using the scanner.";
  return false;
}

function doorToken() {
  return localStorage.getItem("qai_token") || "";
}

async function doorApi(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = doorToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/v1${path}`, { ...options, headers });
  if (res.status === 401) {
    window.onSessionExpired?.("Session expired — sign in again.");
    const expired = new Error("Session expired — sign in again.");
    expired.status = 401;
    throw expired;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const failure = new Error(typeof detail === "string" ? detail : res.statusText);
    failure.status = res.status;
    throw failure;
  }
  return data;
}

function mjpegStreamUrl() {
  const token = doorToken();
  if (!token) return "";
  return `/api/v1/camera/mjpeg?token=${encodeURIComponent(token)}&t=${Date.now()}`;
}

function startLiveStream() {
  if (!requireCameraConfigured("live view")) return false;
  const img = document.getElementById("ipcam");
  if (!img) return false;
  if (streamActive && img.src.includes("/camera/mjpeg")) return true;
  img.src = mjpegStreamUrl();
  streamActive = true;
  document.getElementById("door-live-tag")?.classList.remove("hidden");
  return true;
}

function stopLiveStream() {
  streamActive = false;
  const img = document.getElementById("ipcam");
  if (img) img.src = "";
  document.getElementById("door-live-tag")?.classList.add("hidden");
}

function setBanner(kind, text) {
  const banner = document.getElementById("decision-banner");
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove("allowed", "denied");
  if (kind === "allowed") banner.classList.add("allowed");
  if (kind === "denied") banner.classList.add("denied");
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function reasonLabel(reason) {
  return (
    {
      authorized: "Authorized face",
      not_assigned: "Employee found, door access revoked",
      no_schedule: "Access denied — no entry timer set",
      outside_schedule: "Access denied — outside auto-unlock hours",
      outside_hours: "Access denied — outside your hours",
      unrecognized: "Unknown face",
      no_face: "No face",
      face: "Face unlock",
      manual: "Open door button",
      schedule: "Auto schedule",
      exit_button: "Inside exit button",
    }[reason] || reason || "—"
  );
}

function setScheduleStatus(text, kind) {
  const el = document.getElementById("door-schedule-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind === "ok") el.classList.add("ok");
  if (kind === "err") el.classList.add("err");
}

function renderAutoUnlockLive(status) {
  autoUnlockLive = status || null;
  const el = document.getElementById("auto-unlock-live");
  if (!el || !status) return;
  el.classList.remove("ok", "err", "dim");
  if (!status.enabled) {
    el.classList.add("dim");
    el.innerHTML = '<span class="pill pill-off">Auto-unlock off</span> Enable the schedule above to open the door on a timer.';
    return;
  }
  const pillClass = status.active ? "pill-ok" : "pill";
  const daysPart =
    status.days_label && !String(status.summary).includes(status.days_label)
      ? ` · ${status.days_label}`
      : "";
  el.innerHTML = `<span class="pill ${pillClass}">${doorEscapeHtml(status.status_label)}</span> ${doorEscapeHtml(status.summary)}${doorEscapeHtml(daysPart)}`;
  if (status.active) el.classList.add("ok");
  else el.classList.add("dim");
}

function isInTimeWindow(start, end) {
  if (!start || !end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(start).split(":").map((n) => parseInt(n, 10));
  const [eh, em] = String(end).split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(sh) || Number.isNaN(eh)) return false;
  const s = sh * 60 + (sm || 0);
  const e = eh * 60 + (em || 0);
  if (s <= e) return cur >= s && cur <= e;
  return cur >= s || cur <= e;
}

function readDayChecks(containerId) {
  const root = document.getElementById(containerId);
  if (!root) return "0,1,2,3,4";
  const days = [];
  root.querySelectorAll('input[type="checkbox"][data-day]').forEach((cb) => {
    if (cb.checked) days.push(cb.dataset.day);
  });
  return days.length ? days.join(",") : "0,1,2,3,4,5,6";
}

function applyDayChecks(containerId, daysStr) {
  const set = new Set(String(daysStr || "").split(",").map((d) => d.trim()));
  const root = document.getElementById(containerId);
  if (!root) return;
  root.querySelectorAll('input[type="checkbox"][data-day]').forEach((cb) => {
    cb.checked = set.has(cb.dataset.day);
  });
}

async function loadDoorSchedule() {
  try {
    const s = await doorApi("/door/schedule");
    document.getElementById("auto-unlock-enabled").checked = !!s.auto_unlock_enabled;
    document.getElementById("auto-unlock-start").value = s.auto_unlock_start || "08:00";
    document.getElementById("auto-unlock-end").value = s.auto_unlock_end || "18:00";
    applyDayChecks("auto-unlock-day-checks", s.auto_unlock_days);
    renderAutoUnlockLive(s.status);
    setScheduleStatus("Schedule loaded.", "ok");
  } catch (e) {
    setScheduleStatus(e.message, "err");
  }
}

async function saveDoorSchedule() {
  const btn = document.getElementById("btn-save-schedule");
  if (btn) btn.disabled = true;
  setScheduleStatus("Saving schedule…");
  try {
    const start = document.getElementById("auto-unlock-start")?.value;
    const end = document.getElementById("auto-unlock-end")?.value;
    const enabled = document.getElementById("auto-unlock-enabled").checked;
    if (enabled && (!start || !end)) {
      setScheduleStatus("Set both start and end times.", "err");
      return;
    }
    if (enabled && start === end) {
      setScheduleStatus("Start and end must be different.", "err");
      return;
    }
    const payload = enabled
      ? {
          auto_unlock_enabled: true,
          auto_unlock_start: start,
          auto_unlock_end: end,
          auto_unlock_days: readDayChecks("auto-unlock-day-checks"),
        }
      : { auto_unlock_enabled: false };
    const saved = await doorApi("/door/schedule", { method: "PUT", body: JSON.stringify(payload) });
    document.getElementById("auto-unlock-enabled").checked = saved.auto_unlock_enabled ?? enabled;
    renderAutoUnlockLive(saved.status);
    const live = saved.status;
    if (!enabled) {
      setScheduleStatus("Saved · auto-unlock disabled.", "ok");
    } else if (live?.active) {
      setScheduleStatus("Saved · door is unlocking now (inside the window).", "ok");
    } else if (live?.enabled) {
      setScheduleStatus(`Saved · ${live.summary}`, "ok");
    } else {
      setScheduleStatus("Schedule saved.", "ok");
    }
    refreshDoorStatus();
    loadDoorLog();
  } catch (e) {
    setScheduleStatus(e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function savePersonSchedule(personId, body) {
  await doorApi(`/people/${encodeURIComponent(personId)}/schedule`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// The scanner runs on the server and survives page reloads and restarts: mirror its real state.
function syncScannerState(active) {
  if (active === scannerActive) return;
  scannerActive = active;
  const startBtn = document.getElementById("btn-start-check");
  const stopBtn = document.getElementById("btn-stop-check");
  if (startBtn) startBtn.disabled = active;
  if (stopBtn) stopBtn.disabled = !active;
  if (active && doorPageVisible) scanLoop();
  if (!active) setBanner("wait", "Camera off");
}

async function refreshDoorStatus() {
  try {
    const [summary, door] = await Promise.all([
      doorApi("/access/summary"),
      doorApi("/door/status"),
    ]);
    if (typeof door.scanner_active === "boolean") syncScannerState(door.scanner_active);
    document.getElementById("stat-authorized").textContent = summary.authorized;
    document.getElementById("stat-pending").textContent = summary.pending;
    document.getElementById("stat-allowed").textContent = summary.allowed_today;
    document.getElementById("stat-unlocks").textContent = summary.unlocks_today;

    const pill = document.getElementById("device-pill");
    const label = document.getElementById("device-label");
    const hero = document.getElementById("door-hero");
    const unlocking = door.door_state === "unlocking";
    const relayOn = Boolean(door.relay_on);
    const schedule = door.auto_unlock;
    if (schedule) renderAutoUnlockLive(schedule);
    const autoActive = Boolean(schedule?.active);
    pill?.classList.toggle("online", door.device_online);
    if (door.device_online) {
      const parts = ["ESP32 on Wi‑Fi"];
      if (door.device_ip) parts.push(door.device_ip);
      if (door.mac) parts.push(door.mac);
      if (label) label.textContent = parts.join(" · ");
    } else if (label) {
      label.textContent = door.mac ? `ESP32 offline · ${door.mac}` : "ESP32 offline";
    }
    const stateLabel = document.getElementById("door-state-label");
    if (stateLabel) {
      if (unlocking) stateLabel.textContent = "Opening";
      else if (autoActive) stateLabel.textContent = "Building open";
      else if (relayOn) stateLabel.textContent = "Relay on";
      else stateLabel.textContent = "Relay off";
    }
    hero?.classList.toggle("unlocked", unlocking || relayOn || autoActive);
    const hint = document.getElementById("door-hint");
    if (hint) {
      hint.textContent = door.device_online
        ? unlocking
          ? "Door is opening for exit or face unlock."
          : autoActive
            ? `Building hours · ${schedule.start}–${schedule.end}. Door opens only for allowed face scans.`
            : relayOn
              ? "Relay is on. Turn off to release it."
              : "Outside: camera. Inside: press the exit button to leave."
        : "Waiting for the ESP32 to join Wi‑Fi and reach this PC.";
    }
    // Segmented on/off switch: the selected segment carries .is-on and aria-pressed="true".
    const relayOnBtn = document.getElementById("btn-relay-on");
    const relayOffBtn = document.getElementById("btn-relay-off");
    if (relayOnBtn) {
      relayOnBtn.disabled = relayOn;
      relayOnBtn.classList.toggle("is-on", relayOn);
      relayOnBtn.setAttribute("aria-pressed", relayOn ? "true" : "false");
    }
    if (relayOffBtn) {
      relayOffBtn.disabled = !relayOn;
      relayOffBtn.classList.toggle("is-on", !relayOn);
      relayOffBtn.setAttribute("aria-pressed", relayOn ? "false" : "true");
    }
  } catch {
    /* ignore until signed in */
  }
}

async function loadPeople() {
  const body = document.getElementById("people-body");
  if (!body) return;
  try {
    const people = await doorApi("/people");
    body.innerHTML = people.length
      ? people
          .map((p) => {
            const isManager = p.employee_type === "manager" || p.is_manager;
            const hasTimer = !!(p.door_access_start && p.door_access_end);
            const inWindow = hasTimer && isInTimeWindow(p.door_access_start, p.door_access_end);
            const typePill = isManager
              ? '<span class="pill pill-ok">Manager</span>'
              : '<span class="pill">Employee</span>';
            const accessPill = isManager
              ? "Door allowed"
              : inWindow
                ? "Can enter now"
                : hasTimer
                  ? "Outside timer"
                  : "Cannot enter";
            const accessClass = isManager || inWindow ? "pill-ok" : hasTimer ? "pill" : "pill-off";
            const hoursLabel = isManager
              ? "24/7 — face unlock always allowed"
              : hasTimer
                ? inWindow
                  ? `Active now · door opens on face scan (${p.door_access_start}–${p.door_access_end})`
                  : `Outside timer · door locked until ${p.door_access_start}–${p.door_access_end}`
                : "No timer — set start + end below, then Save timer";
            const pid = doorEscapeHtml(p.person_id);
            return `<div class="person-card" data-person-id="${pid}">
              <span class="avatar" aria-hidden="true">${doorEscapeHtml(doorInitials(p.name))}</span>
              <div style="flex:1;min-width:0">
                <strong>${doorEscapeHtml(p.name)}</strong>
                <small>${pid} · <span class="pill ${accessClass}">${accessPill}</span> ${typePill}</small>
                <div class="person-schedule">
                  <label>Role</label>
                  <select class="emp-type" data-id="${pid}" aria-label="Door role">
                    <option value="employee" ${isManager ? "" : "selected"}>Employee</option>
                    <option value="manager" ${isManager ? "selected" : ""}>Manager</option>
                  </select>
                  <label class="sr-only">Entry start</label>
                  <input type="time" class="emp-start" data-id="${pid}" aria-label="Entry timer start" value="${doorEscapeHtml(p.door_access_start || "")}" ${isManager ? "disabled" : ""} title="Entry timer start" />
                  <label class="sr-only">Entry end</label>
                  <input type="time" class="emp-end" data-id="${pid}" aria-label="Entry timer end" value="${doorEscapeHtml(p.door_access_end || "")}" ${isManager ? "disabled" : ""} title="Entry timer end" />
                  <button type="button" class="ghost small emp-hours-save" data-id="${pid}">Save timer</button>
                  <button type="button" class="ghost small emp-hours-clear" data-id="${pid}">Clear timer</button>
                </div>
                <small class="status dim">${doorEscapeHtml(hoursLabel)}</small>
              </div>
            </div>`;
          })
          .join("")
      : '<p class="status dim">No employees yet. Enroll them in Admin users — they will appear here with door access.</p>';

    body.querySelectorAll(".emp-type").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const id = sel.dataset.id;
        const card = sel.closest(".person-card");
        const isManager = sel.value === "manager";
        try {
          await savePersonSchedule(id, { is_manager: isManager });
          card?.querySelectorAll(".emp-start, .emp-end").forEach((el) => {
            el.disabled = isManager;
          });
          await loadPeople();
        } catch (e) {
          alert(e.message);
          await loadPeople();
        }
      });
    });
    body.querySelectorAll(".emp-hours-save").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const card = btn.closest(".person-card");
        const start = card?.querySelector(".emp-start")?.value || "";
        const end = card?.querySelector(".emp-end")?.value || "";
        btn.disabled = true;
        try {
          if ((start && !end) || (!start && end)) {
            alert("Set both start and end times, or use Clear hours.");
            return;
          }
          await savePersonSchedule(id, {
            door_access_start: start || null,
            door_access_end: end || null,
            clear_hours: !start && !end,
          });
          await loadPeople();
          await refreshDoorStatus();
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
    body.querySelectorAll(".emp-hours-clear").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await savePersonSchedule(btn.dataset.id, { clear_hours: true });
          await loadPeople();
        } catch (e) {
          alert(e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    body.innerHTML = `<p class="status dim">${doorEscapeHtml(e.message)}</p>`;
  }
}

async function loadDoorLog() {
  const body = document.getElementById("log-body");
  if (!body) return;
  try {
    const [entries, commands] = await Promise.all([
      doorApi("/access/entries?limit=40"),
      doorApi("/door/history?limit=40"),
    ]);
    const rows = [
      ...entries.map((e) => ({
        time: e.timestamp,
        person: e.person_name || "Unknown",
        initials: e.person_name ? doorInitials(e.person_name) : "?",
        event: e.decision === "allowed" ? "Allowed" : "Denied",
        ok: e.decision === "allowed",
        detail: reasonLabel(e.reason),
      })),
      ...commands.map((c) => ({
        time: c.created_at,
        person:
          c.source === "schedule"
            ? "Auto-unlock schedule"
            : c.person_name || c.requested_by || "Admin",
        initials:
          c.source === "schedule"
            ? ""
            : doorInitials(c.person_name || c.requested_by || "Admin"),
        event: c.status === "expired" ? "Expired" : c.source === "schedule" ? "Auto-unlock" : "Unlock",
        ok: c.status !== "expired",
        detail: reasonLabel(c.source) + ` · ${c.status}`,
      })),
    ].sort((a, b) => String(b.time).localeCompare(String(a.time)));

    body.innerHTML = rows.length
      ? rows
          .slice(0, 40)
          .map(
            (r) => `<div class="log-row">
              <span class="avatar" aria-hidden="true">${
                r.initials
                  ? doorEscapeHtml(r.initials)
                  : '<svg class="icon" aria-hidden="true"><use href="#i-clock"></use></svg>'
              }</span>
              <div style="flex:1;min-width:0">
                <strong>${doorEscapeHtml(r.person)}</strong>
                <small>${doorEscapeHtml(formatTime(r.time))} · ${doorEscapeHtml(r.detail)}</small>
              </div>
              <span class="pill ${r.ok ? "pill-ok" : "pill-bad"}">${r.event}</span>
            </div>`
          )
          .join("")
      : '<p class="status dim">No face checks or unlocks yet.</p>';
  } catch (e) {
    body.innerHTML = `<p class="status dim">${doorEscapeHtml(e.message)}</p>`;
  }
}

async function loadDoorDashboard() {
  await Promise.all([refreshDoorStatus(), loadPeople(), loadDoorLog()]);
}

async function setRelay(on) {
  const statusEl = document.getElementById("relay-status");
  const onBtn = document.getElementById("btn-relay-on");
  const offBtn = document.getElementById("btn-relay-off");
  // Disabling the focused segment drops keyboard focus to <body>; return it to the usable segment.
  const hadFocus = document.activeElement === onBtn || document.activeElement === offBtn;
  onBtn.disabled = true;
  offBtn.disabled = true;
  statusEl.textContent = on ? "Turning relay on…" : "Turning relay off…";
  try {
    const result = await doorApi("/door/relay", {
      method: "POST",
      body: JSON.stringify({ on }),
    });
    statusEl.textContent = result.message;
    await loadDoorDashboard();
  } catch (e) {
    statusEl.textContent = e.message;
    await loadDoorDashboard();
  }
  if (hadFocus) {
    (onBtn.disabled ? offBtn : onBtn)?.focus();
  }
}

function applyScanResult(result) {
  const statusEl = document.getElementById("camera-status");
  if (result.reason === "no_face") {
    if (autoUnlockLive?.active) {
      setBanner("wait", `Building hours · ${autoUnlockLive.start}–${autoUnlockLive.end}`);
      if (statusEl) statusEl.textContent = "Waiting for an allowed face scan…";
    } else {
      setBanner("wait", "Stand in front of the door camera");
      if (statusEl) statusEl.textContent = "Waiting for a face…";
    }
    return;
  }
  if (result.allowed) {
    setBanner("allowed", result.unlocked ? `Open · ${result.person_name}` : `Allowed · ${result.person_name}`);
  } else if (result.reason === "no_schedule") {
    setBanner(
      "denied",
      result.person_name
        ? `No entry timer · ${result.person_name}`
        : "Access denied — no entry timer set"
    );
  } else if (result.reason === "outside_schedule") {
    setBanner(
      "denied",
      result.person_name
        ? `Outside auto-unlock hours · ${result.person_name}`
        : "Access denied — outside auto-unlock hours"
    );
  } else if (result.reason === "outside_hours") {
    setBanner(
      "denied",
      result.person_name
        ? `Access denied — outside your hours · ${result.person_name}`
        : "Access denied — outside your hours"
    );
  } else {
    setBanner("denied", result.person_name ? `Denied · ${result.person_name}` : "Denied · Unknown");
  }
  if (statusEl) {
    statusEl.textContent = result.unlocked
      ? "Unlock sent to the lock."
      : `${result.person_name || "Unknown"} — ${reasonLabel(result.reason)}`;
  }
  const isEvent = result.event?.logged || result.unlocked;
  if (isEvent && (result.sequence == null || result.sequence !== lastHighlightSeq)) {
    lastHighlightSeq = result.sequence ?? null;
    loadDoorLog();
    refreshDoorStatus();
  }
}

async function tickCheck() {
  try {
    const result = await doorApi("/access/scan-result");
    applyScanResult(result);
  } catch (e) {
    if (e.status === 409) {
      syncScannerState(false);
      return;
    }
    const statusEl = document.getElementById("camera-status");
    if (statusEl) statusEl.textContent = e.message;
  }
}

async function scanLoop() {
  if (scanLoop.running) return;
  scanLoop.running = true;
  try {
    // Display-only poll; runs only while the Door page is visible.
    while (scannerActive && doorPageVisible) {
      const started = performance.now();
      await tickCheck();
      const elapsed = performance.now() - started;
      const wait = Math.max(0, SCAN_POLL_MS - elapsed);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  } finally {
    scanLoop.running = false;
  }
}

async function startCheck() {
  if (scannerActive) return;
  const startBtn = document.getElementById("btn-start-check");
  if (startBtn?.disabled) return;
  if (!startLiveStream()) return;
  const statusEl = document.getElementById("camera-status");
  if (statusEl) statusEl.textContent = "Starting face scanner…";
  if (startBtn) startBtn.disabled = true;
  try {
    await doorApi("/access/scanner/start", { method: "POST" });
  } catch (e) {
    stopLiveStream();
    if (startBtn) startBtn.disabled = false;
    throw e;
  }
  scannerActive = true;
  if (statusEl) statusEl.textContent = "Live view — scanning faces…";
  document.getElementById("btn-start-check").disabled = true;
  document.getElementById("btn-stop-check").disabled = false;
  setBanner("wait", "Stand in front of the door camera");
  scanLoop();
}

async function stopCheck() {
  scannerActive = false;
  try {
    await doorApi("/access/scanner/stop", { method: "POST" });
  } catch {
    /* scanner may already be stopped */
  }
  const startBtn = document.getElementById("btn-start-check");
  const stopBtn = document.getElementById("btn-stop-check");
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  setBanner("wait", "Camera off");
}

function bindDoorOnce() {
  if (bindDoorOnce.done) return;
  bindDoorOnce.done = true;

  document.getElementById("btn-open-door")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-open-door");
    const statusEl = document.getElementById("open-status");
    btn.disabled = true;
    statusEl.textContent = "Sending unlock…";
    try {
      const result = await doorApi("/door/open", { method: "POST", body: JSON.stringify({}) });
      statusEl.textContent = result.message;
      await loadDoorDashboard();
    } catch (e) {
      statusEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-relay-on")?.addEventListener("click", () => setRelay(true));
  document.getElementById("btn-relay-off")?.addEventListener("click", () => setRelay(false));

  document.getElementById("btn-start-check")?.addEventListener("click", () => {
    startCheck().catch((e) => {
      document.getElementById("camera-status").textContent = e.message;
    });
  });
  document.getElementById("btn-stop-check")?.addEventListener("click", async () => {
    await stopCheck();
    stopLiveStream();
    document.getElementById("camera-status").textContent = "Scanner stopped.";
  });
  document.getElementById("btn-refresh-people")?.addEventListener("click", loadPeople);
  document.getElementById("btn-refresh-log")?.addEventListener("click", loadDoorLog);
  document.getElementById("btn-save-camera")?.addEventListener("click", saveCameraConfig);
  document.getElementById("btn-test-camera")?.addEventListener("click", testCameraConfig);
  document.getElementById("btn-save-schedule")?.addEventListener("click", saveDoorSchedule);
}

window.DoorLock = {
  async onShow() {
    doorPageVisible = true;
    bindDoorOnce();
    await loadCameraConfig();
    await loadDoorSchedule();
    if (!doorPageVisible) return;
    if (cameraConfigured) startLiveStream();
    loadDoorDashboard();
    doorStatusTimer && clearInterval(doorStatusTimer);
    doorStatusTimer = setInterval(refreshDoorStatus, 3000);
    if (scannerActive) scanLoop();
  },
  async onHide() {
    // Local cleanup only. The scanner is server-global (face unlock for the
    // building), so it is stopped only by the explicit Stop button.
    doorPageVisible = false;
    stopLiveStream();
    if (doorStatusTimer) {
      clearInterval(doorStatusTimer);
      doorStatusTimer = null;
    }
  },
};
