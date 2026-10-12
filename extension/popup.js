// Popup: daemon status, the current tab's grant, and the grant list. It talks to
// the service worker only; the daemon is never contacted from here.

const statusEl = document.getElementById("status");
const currentEl = document.getElementById("current");
const toggleBtn = document.getElementById("toggle");
const errorEl = document.getElementById("error");
const listEl = document.getElementById("allowed");
const emptyEl = document.getElementById("empty");

let currentTab = null;
let renderSeq = 0;

function showError(message) {
  errorEl.textContent = message || "";
  errorEl.hidden = !message;
}

async function askWorker(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply || reply.ok !== true) {
    throw new Error((reply && reply.error) || "BrowseForMe Bridge did not answer.");
  }
  return reply;
}

async function refreshStatus() {
  try {
    const { connected } = await askWorker({ type: "getState" });
    statusEl.dataset.state = connected ? "connected" : "down";
    statusEl.textContent = connected
      ? "Daemon: connected"
      : "Daemon: not connected, retrying";
  } catch (err) {
    statusEl.dataset.state = "down";
    statusEl.textContent = `Daemon: unknown (${err.message})`;
  }
}

function renderCurrent(allowed) {
  if (!currentTab) {
    currentEl.textContent = "No active tab.";
    toggleBtn.disabled = true;
    return;
  }
  const on = allowed.includes(currentTab.id);
  currentEl.textContent = currentTab.title || currentTab.url || "(untitled tab)";
  toggleBtn.disabled = false;
  toggleBtn.dataset.state = on ? "on" : "off";
  toggleBtn.textContent = on ? "ON: click to turn off" : "OFF: click to turn on";
}

function renderGrants(allowed, infos) {
  listEl.replaceChildren();
  let rows = 0;
  allowed.forEach((tabId, i) => {
    const tab = infos[i];
    if (!tab) return;
    rows += 1;
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "title";
    label.textContent = tab.title || tab.url || `Tab ${tabId}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.dataset.tab = String(tabId);
    item.append(label, remove);
    listEl.append(item);
  });
  emptyEl.hidden = rows > 0;
}

async function render() {
  const seq = ++renderSeq;
  const { allowedTabs } = await chrome.storage.session.get("allowedTabs");
  const allowed = Array.isArray(allowedTabs) ? allowedTabs : [];
  const infos = await Promise.all(allowed.map((id) => chrome.tabs.get(id).catch(() => null)));
  if (seq !== renderSeq) return; // a newer render is in flight
  renderCurrent(allowed);
  renderGrants(allowed, infos);
}

async function run(action) {
  toggleBtn.disabled = true;
  showError("");
  try {
    await action();
  } catch (err) {
    showError(err.message);
  } finally {
    await render();
  }
}

toggleBtn.addEventListener("click", () => {
  if (currentTab) run(() => askWorker({ type: "toggle", tabId: currentTab.id }));
});

listEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (button) run(() => askWorker({ type: "revoke", tabId: Number(button.dataset.tab) }));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.allowedTabs) render();
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  await Promise.all([refreshStatus(), render()]);
  setTimeout(refreshStatus, 1500);
}

init().catch((err) => showError(err.message));
