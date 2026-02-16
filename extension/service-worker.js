// Background/service worker for Polychrome Capture
// Receives scraped tasks from content scripts, optionally saves them to the API.

const PROD_ORIGIN = "https://polychrome.appwrite.network";
const DEV_ORIGIN = "http://localhost:3000";
const API_TASKS_PATH = "/api/tasks";
const ENV_STORAGE_KEY = "apiOriginMode"; // 'prod' | 'dev' | custom URL

let currentOrigin = PROD_ORIGIN;
const originReady = loadOriginFromStorage();
let lastScrapedTasks = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SCRAPED_TASKS") {
    lastScrapedTasks = (msg.tasks || []).map((t) => ({
      title: t.title || "Captured task",
      description: t.description || "",
      dueDate: t.dueDate || null,
      labels: t.labels || ["capture", "web"],
      status: t.status || "todo",
      priority: t.priority || "medium",
      url: t.url || sender?.tab?.url || "",
      raw: t.raw || "",
    }));
    sendResponse({ ok: true, tasks: lastScrapedTasks });
    return true;
  }

  if (msg.type === "GET_LAST_TASKS") {
    sendResponse({ ok: true, tasks: lastScrapedTasks });
    return true;
  }

  if (msg.type === "SAVE_TASKS") {
    saveTasks(msg.tasks || [], msg.options || {})
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // keep channel open
  }

  if (msg.type === "GET_ENV") {
    sendResponse({
      ok: true,
      origin: currentOrigin,
      mode: resolveMode(currentOrigin),
    });
    return true;
  }

  if (msg.type === "SET_ENV") {
    const next = msg.mode || msg.origin;
    setOrigin(next).then((origin) =>
      sendResponse({ ok: true, origin, mode: resolveMode(origin) }),
    );
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ENV_STORAGE_KEY]) return;
  setOrigin(changes[ENV_STORAGE_KEY].newValue);
});

async function saveTasks(tasks, options = {}) {
  const merged = tasks.map((t) => ({
    title: t.title || "Captured task",
    description: t.description || formatDescription(t),
    status: t.status || "todo",
    priority: t.priority || "medium",
    dueDate: t.dueDate || null,
    labels: normalizeLabels(t.labels || ["capture", "web"]),
  }));
  const results = [];
  for (const task of merged) {
    const res = await postTask(task, options);
    results.push(res);
  }
  return results;
}

function normalizeLabels(labels) {
  if (!labels) return [];
  if (Array.isArray(labels)) return labels;
  if (typeof labels === "string")
    return labels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function formatDescription(task) {
  const parts = [];
  if (task.url) parts.push(`Captured from: ${task.url}`);
  if (task.raw) parts.push(task.raw);
  return parts.join("\n\n");
}

async function postTask(task, options) {
  await originReady;

  const body = {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    labels: task.labels,
  };

  const res = await fetch(`${currentOrigin}${API_TASKS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // send session cookie to Polychrome
    body: JSON.stringify(body),
    ...options.fetchOptions,
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json();
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (e) {
    return "no body";
  }
}

async function loadOriginFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ENV_STORAGE_KEY], (result) => {
      setOrigin(result[ENV_STORAGE_KEY] || "prod").finally(resolve);
    });
  });
}

async function setOrigin(modeOrUrl) {
  const resolved = resolveOrigin(modeOrUrl);
  currentOrigin = resolved;
  chrome.storage.local.set({ [ENV_STORAGE_KEY]: modeOrUrl });
  return resolved;
}

function resolveOrigin(modeOrUrl) {
  if (!modeOrUrl || modeOrUrl === "prod") return PROD_ORIGIN;
  if (modeOrUrl === "dev") return DEV_ORIGIN;
  if (typeof modeOrUrl === "string" && modeOrUrl.startsWith("http"))
    return modeOrUrl;
  return PROD_ORIGIN;
}

function resolveMode(origin) {
  if (origin === DEV_ORIGIN) return "dev";
  if (origin === PROD_ORIGIN) return "prod";
  return "custom";
}
