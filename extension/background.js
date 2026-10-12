// BrowseForMe Bridge: MV3 service worker. Grants individual tabs to the local
// daemon and relays DevTools Protocol commands, results, and events over one
// WebSocket.

const PORT_MIN = 47821;
const PORT_MAX = 47830;
const HEALTH_TIMEOUT_MS = 800;
const TOKEN_TIMEOUT_MS = 2000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const PUSH_DEBOUNCE_MS = 30;
const DEBUGGER_VERSION = "1.3";
const BADGE_COLOR = "#16a34a";

// Grants live in chrome.storage.session so they survive worker restarts.
// Everything else is runtime-only and rebuilt on demand.
const attachedTabs = new Set(); // tabs this worker holds a debugger attachment for
const attaching = new Map(); // tabId -> in-flight attach promise
const pendingDetached = new Map(); // tabId -> reason, sent on the next hello-ack
let ws = null; // current daemon socket
let ready = false; // hello-ack received on ws
let connecting = false;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pushTimer = null;
let lastTabState = null; // JSON of the last tabState sent on ws
let queue = Promise.resolve();

function errMsg(err) {
  return (err && err.message) || String(err);
}

function logError(err) {
  console.warn("BrowseForMe Bridge:", errMsg(err));
}

// Serializes registry writes and tabState pushes. A queued task must never
// await another queued task, or the queue deadlocks.
function serialize(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// ---- Grant registry ----

async function getAllowed() {
  const { allowedTabs } = await chrome.storage.session.get("allowedTabs");
  return Array.isArray(allowedTabs) ? allowedTabs : [];
}

function setAllowed(list) {
  return chrome.storage.session.set({ allowedTabs: list });
}

async function isAllowed(tabId) {
  return (await getAllowed()).includes(tabId);
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  } catch {
    // The tab is gone; nothing to badge.
  }
}

function toggleTab(tabId) {
  return serialize(async () => {
    if (await isAllowed(tabId)) {
      await revokeLocked(tabId, "released");
      return { allowed: false };
    }
    await grantLocked(tabId);
    return { allowed: true };
  });
}

// Callers hold the queue (serialize). One tab at a time: granting a tab revokes every
// other grant first (debugger detached, badge cleared, daemon told the session ended).
async function grantLocked(tabId) {
  await chrome.tabs.get(tabId); // throws if the tab does not exist
  for (const other of await getAllowed()) {
    if (other === tabId) continue;
    await releaseTab(other, "replaced");
    await setBadge(other, false);
  }
  await setAllowed([tabId]);
  await setBadge(tabId, true);
  await pushLocked();
}

// Callers hold the queue (serialize).
async function revokeLocked(tabId, reason) {
  const allowed = await getAllowed();
  if (allowed.includes(tabId)) await setAllowed(allowed.filter((id) => id !== tabId));
  await releaseTab(tabId, reason);
  await setBadge(tabId, false);
  await pushLocked();
}

// Detaches our debugger session if any, and tells the daemon the tab's session ended.
async function releaseTab(tabId, reason) {
  const wasAttached = attachedTabs.delete(tabId);
  let detached = false;
  try {
    await chrome.debugger.detach({ tabId });
    detached = true;
  } catch {
    // Not attached, or the tab is already gone.
  }
  if (wasAttached || detached) notifyDetached(tabId, reason);
}

// ---- tabState ----

async function focusedTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

// Callers hold the queue (serialize). Prunes closed tabs, then sends the full list
// when it differs from the last frame sent on this connection.
async function pushLocked() {
  const allowed = await getAllowed();
  const [focused, infos] = await Promise.all([
    focusedTabId(),
    Promise.all(allowed.map((id) => chrome.tabs.get(id).catch(() => null))),
  ]);
  const live = [];
  const tabs = [];
  allowed.forEach((tabId, i) => {
    const tab = infos[i];
    if (!tab) return;
    live.push(tabId);
    tabs.push({
      tabId,
      url: tab.url || tab.pendingUrl || "",
      title: tab.title || "",
      active: tabId === focused,
      allowed: true,
    });
  });
  if (live.length !== allowed.length) await setAllowed(live);
  const json = JSON.stringify(tabs);
  if (json !== lastTabState && sendOn(ws, { type: "tabState", tabs })) lastTabState = json;
}

function schedulePush() {
  if (pushTimer !== null) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    serialize(pushLocked).catch(logError);
  }, PUSH_DEBOUNCE_MS);
}

// ---- Daemon discovery and socket ----

async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = res.ok ? await res.json() : null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function findPort() {
  const ports = [];
  for (let port = PORT_MIN; port <= PORT_MAX; port++) ports.push(port);
  const healthy = await Promise.all(ports.map((port) => probeHealth(port)));
  const index = healthy.indexOf(true);
  return index === -1 ? null : ports[index];
}

async function fetchToken(port) {
  // POST: Chrome attaches the Origin header the daemon checks only to non-GET requests.
  const res = await fetch(`http://127.0.0.1:${port}/api/token`, {
    method: "POST",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`/api/token answered ${res.status}`);
  const { token } = await res.json();
  if (typeof token !== "string" || token === "") throw new Error("/api/token sent no token");
  await chrome.storage.session.set({ token });
  return token;
}

// Starts one attempt unless a socket is already open or opening.
async function connect() {
  if (connecting || (ws !== null && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const port = await findPort();
    if (port === null) throw new Error("no daemon on ports 47821-47830");
    const token = await fetchToken(port);
    openSocket(port, token);
  } catch (err) {
    logError(err);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function openSocket(port, token) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ext?token=${encodeURIComponent(token)}`);
  ws = sock;
  ready = false;
  // The handshake (open, then hello-ack) must finish in time. A stalled socket is
  // closed, which reaches onclose and schedules a retry.
  const handshakeTimer = setTimeout(() => {
    if (ws === sock && !ready) sock.close();
  }, HANDSHAKE_TIMEOUT_MS);
  // MV3 stops an idle worker after ~30 s, which would drop the daemon connection.
  // Any extension API call resets the idle timer, so ping one every 20 s while connected.
  let keepAlive = null;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: "hello", version: chrome.runtime.getManifest().version }));
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  };
  sock.onmessage = (event) => onFrame(sock, event.data);
  sock.onclose = () => {
    clearTimeout(handshakeTimer);
    clearInterval(keepAlive);
    if (ws !== sock) return; // a newer socket already replaced this one
    ws = null;
    ready = false;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Connects now, cancelling any pending backoff timer. Runs on worker start,
// browser startup, and when the popup asks for state.
function ensureConnected() {
  if (ws !== null && ws.readyState <= WebSocket.OPEN) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

// ---- Frames from the daemon ----

function onFrame(sock, data) {
  if (sock !== ws) return; // a replaced socket must not run commands
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  switch (msg?.type) {
    case "hello-ack":
      onHelloAck();
      break;
    case "cmd":
      handleCmd(sock, msg);
      break;
    case "createTab":
      handleCreateTab(sock, msg);
      break;
    case "closeTab":
      handleCloseTab(sock, msg);
      break;
  }
}

function onHelloAck() {
  ready = true;
  backoff = BACKOFF_MIN_MS;
  lastTabState = null; // every connection starts from a full tabState
  serialize(pushLocked).catch(logError);
  for (const [tabId, reason] of pendingDetached) {
    if (sendOn(ws, { type: "detached", tabId, reason })) pendingDetached.delete(tabId);
  }
}

// Sends only on the socket that is current and past hello-ack, so a reply never
// reaches a daemon that did not ask for it.
function sendOn(sock, frame) {
  if (!sock || sock !== ws || !ready || sock.readyState !== WebSocket.OPEN) return false;
  sock.send(JSON.stringify(frame));
  return true;
}

// Held while no socket is ready; sent on the next hello-ack.
function notifyDetached(tabId, reason) {
  if (!sendOn(ws, { type: "detached", tabId, reason })) pendingDetached.set(tabId, reason);
}

// ---- Commands ----

async function handleCmd(sock, { id, tabId, method, params }) {
  try {
    if (!(await isAllowed(tabId))) throw new Error(`Tab ${tabId} is not allowed.`);
    const result = await runCommand(tabId, method, params ?? {});
    sendOn(sock, { type: "res", id, result: result ?? {} });
  } catch (err) {
    sendOn(sock, { type: "res", id, error: errMsg(err) });
  }
}

async function runCommand(tabId, method, params, retried = false) {
  await ensureAttached(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    // Our session vanished without a detach event: reattach once and resend.
    if (!retried && /not attached/i.test(errMsg(err))) {
      attachedTabs.delete(tabId);
      notifyDetached(tabId, "stale");
      return runCommand(tabId, method, params, true);
    }
    throw err;
  }
}

function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return Promise.resolve();
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attachNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

async function attachNow(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (err) {
    const msg = errMsg(err);
    // An earlier run of this worker may still hold the attachment; reuse it only if
    // our client owns it. Otherwise another client (DevTools) does, which is an error.
    if (!/already attached/i.test(msg) || !(await ownsAttachment(tabId))) {
      throw new Error(`Cannot attach debugger to tab ${tabId}: ${msg}`);
    }
  }
  // Re-check the grant and register under the queue. A revoke that finished first is
  // seen here and detaches us; one that runs after detaches the session we registered.
  await serialize(async () => {
    if (!(await isAllowed(tabId))) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw new Error(`Tab ${tabId} is not allowed.`);
    }
    attachedTabs.add(tabId);
  });
}

// sendCommand only reaches sessions this extension owns, so a successful probe proves ownership.
async function ownsAttachment(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
    return true;
  } catch {
    return false;
  }
}

async function handleCreateTab(sock, { id, url }) {
  try {
    // A tab the daemon opens is not granted; the user has to toggle it on.
    const tab = await chrome.tabs.create(url ? { url } : {});
    sendOn(sock, { type: "res", id, result: { tabId: tab.id } });
  } catch (err) {
    sendOn(sock, { type: "res", id, error: errMsg(err) });
  }
}

async function handleCloseTab(sock, { id, tabId }) {
  try {
    if (!(await isAllowed(tabId))) throw new Error(`Tab ${tabId} is not allowed.`);
    await chrome.tabs.remove(tabId);
    sendOn(sock, { type: "res", id, result: {} });
  } catch (err) {
    sendOn(sock, { type: "res", id, error: errMsg(err) });
  }
}

// ---- Chrome events ----

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number" || !attachedTabs.has(source.tabId)) return;
  sendOn(ws, { type: "event", tabId: source.tabId, method, params: params ?? {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") return;
  // releaseTab already reported the detaches we initiated.
  if (attachedTabs.delete(source.tabId)) notifyDetached(source.tabId, reason);
});

chrome.tabs.onActivated.addListener(() => schedulePush());
chrome.windows.onFocusChanged.addListener(() => schedulePush());

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    changeInfo.url === undefined &&
    changeInfo.title === undefined &&
    changeInfo.status === undefined
  ) {
    return;
  }
  serialize(async () => {
    if (!(await isAllowed(tabId))) return;
    await setBadge(tabId, true); // navigation can reset tab-specific badges
    schedulePush();
  }).catch(logError);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(async () => {
    if ((await isAllowed(tabId)) || attachedTabs.has(tabId)) {
      await revokeLocked(tabId, "closed");
    }
  }).catch(logError);
});

// ---- Popup bridge: the popup talks to this worker only ----

function tabIdOf(msg) {
  if (!Number.isInteger(msg.tabId)) throw new Error("Expected an integer tabId.");
  return msg.tabId;
}

async function handleUiMessage(msg) {
  switch (msg?.type) {
    case "getState":
      ensureConnected();
      return { connected: ready };
    case "toggle":
      return toggleTab(tabIdOf(msg));
    case "revoke": {
      const tabId = tabIdOf(msg);
      return serialize(async () => {
        await revokeLocked(tabId, "released");
        return {};
      });
    }
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Forbidden." });
    return false;
  }
  handleUiMessage(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: errMsg(err) }),
  );
  return true;
});

chrome.runtime.onStartup.addListener(() => ensureConnected());

ensureConnected();
