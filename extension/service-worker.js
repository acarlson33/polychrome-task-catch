// Background/service worker for Polychrome Capture
// Receives scraped tasks from content scripts, optionally saves them to the API.

const PROD_ORIGIN = "https://polychrome.appwrite.network";
const DEV_ORIGIN = "http://localhost:3000";
const API_TASKS_PATH = "/api/tasks";
const ENV_STORAGE_KEY = "apiOriginMode"; // 'prod' | 'dev' | custom URL
const PARSER_SETTINGS_KEY = "parserSettings";

const DEFAULT_PARSER_SETTINGS = {
  confidenceMode: "balanced", // 'recall' | 'balanced' | 'precision'
  includeUndatedCandidates: false,
  maxTasks: 50,
  blockedTitlePhrases: [],
  maxPastTaskYears: 2,
};

let currentOrigin = PROD_ORIGIN;
const originReady = loadOriginFromStorage();
let lastScrapedTasks = [];
const scrapedByTab = new Map();
let latestScrapeMeta = { tabId: null, url: "", capturedAt: null, parser: null };

chrome.tabs.onRemoved.addListener((tabId) => {
  scrapedByTab.delete(tabId);
  if (latestScrapeMeta.tabId === tabId) {
    latestScrapeMeta = { tabId: null, url: "", capturedAt: null, parser: null };
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const previous = scrapedByTab.get(tabId);
  if (previous && previous.url !== changeInfo.url) {
    scrapedByTab.delete(tabId);
  }

  if (
    latestScrapeMeta.tabId === tabId &&
    latestScrapeMeta.url !== changeInfo.url
  ) {
    latestScrapeMeta = {
      tabId,
      url: changeInfo.url,
      capturedAt: null,
      parser: null,
    };
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "SCRAPED_TASKS") {
    const normalized = (msg.tasks || []).map((t) => ({
      title: t.title || "Captured task",
      description: t.description || "",
      dueDate: t.dueDate || null,
      labels: t.labels || ["capture", "web"],
      status: t.status || "todo",
      priority: t.priority || "medium",
      url: t.url || sender?.tab?.url || "",
      raw: t.raw || "",
      confidence: t.confidence,
      confidenceLabel: t.confidenceLabel,
      reasons: t.reasons || [],
      hasDueDate: t.hasDueDate !== false,
    }));
    const tabId = sender?.tab?.id ?? msg.tabId ?? null;
    const tabUrl = sender?.tab?.url || msg.url || "";
    const capturedAt = new Date().toISOString();

    lastScrapedTasks = normalized;
    latestScrapeMeta = {
      tabId,
      url: tabUrl,
      capturedAt,
      parser: msg.parser || null,
    };
    if (tabId !== null) {
      scrapedByTab.set(tabId, {
        tasks: normalized,
        url: tabUrl,
        capturedAt,
        parser: msg.parser || null,
      });
    }

    sendResponse({ ok: true, tasks: lastScrapedTasks });
    return true;
  }

  if (msg.type === "GET_LAST_TASKS") {
    const tabId = msg.tabId;
    const byTab =
      tabId !== undefined && tabId !== null ? scrapedByTab.get(tabId) : null;
    if (byTab) {
      sendResponse({
        ok: true,
        tasks: byTab.tasks,
        meta: {
          tabId,
          url: byTab.url,
          capturedAt: byTab.capturedAt,
          parser: byTab.parser || null,
        },
      });
      return true;
    }

    sendResponse({ ok: true, tasks: lastScrapedTasks, meta: latestScrapeMeta });
    return true;
  }

  if (msg.type === "SAVE_TASKS") {
    saveTasks(msg.tasks || [], msg.options || {})
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error.message,
          code: error.code || "SAVE_FAILED",
          authRequired: Boolean(error.authRequired),
          authUrl: error.authUrl || currentOrigin,
          status: error.status,
        }),
      );
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
    setOrigin(next)
      .then((origin) =>
        sendResponse({ ok: true, origin, mode: resolveMode(origin) }),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to update API origin.",
        }),
      );
    return true;
  }

  if (msg.type === "GET_PARSER_SETTINGS") {
    loadParserSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to load parser settings.",
        }),
      );
    return true;
  }

  if (msg.type === "SET_PARSER_SETTINGS") {
    const next = sanitizeParserSettings(msg.settings || {});
    chrome.storage.local.set({ [PARSER_SETTINGS_KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, settings: next });
    });
    return true;
  }

  return false;
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
    throwApiError(res.status, text);
  }

  return res.json();
}

function throwApiError(status, responseText) {
  const details = extractErrorMessage(responseText);

  if (status === 401 || status === 403) {
    const error = new Error("Authentication required. Please sign in first.");
    error.code = "AUTH_REQUIRED";
    error.status = status;
    error.authRequired = true;
    error.authUrl = currentOrigin;
    throw error;
  }

  const error = new Error(`API ${status}: ${details}`);
  error.code = "API_ERROR";
  error.status = status;
  throw error;
}

function extractErrorMessage(text) {
  if (!text) return "no body";
  const trimmed = String(text).trim();
  if (!trimmed) return "no body";

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error === "string") return parsed.error;
    if (typeof parsed?.message === "string") return parsed.message;
    return trimmed;
  } catch (e) {
    return trimmed;
  }
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
      if (chrome.runtime.lastError) {
        setOrigin("prod").finally(resolve);
        return;
      }
      setOrigin(result[ENV_STORAGE_KEY] || "prod").finally(resolve);
    });
  });
}

async function setOrigin(modeOrUrl) {
  const resolved = resolveOrigin(modeOrUrl);
  currentOrigin = resolved;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [ENV_STORAGE_KEY]: modeOrUrl }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resolved);
    });
  });
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

function sanitizeParserSettings(settings) {
  const mode = settings?.confidenceMode;
  const confidenceMode =
    mode === "recall" || mode === "precision" || mode === "balanced"
      ? mode
      : DEFAULT_PARSER_SETTINGS.confidenceMode;

  const maxTasksNum = Number(settings?.maxTasks);
  const maxTasks = Number.isFinite(maxTasksNum)
    ? Math.min(120, Math.max(5, Math.floor(maxTasksNum)))
    : DEFAULT_PARSER_SETTINGS.maxTasks;

  const blockedTitlePhrases = Array.isArray(settings?.blockedTitlePhrases)
    ? settings.blockedTitlePhrases
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    : [];

  const maxPastTaskYears =
    settings?.maxPastTaskYears === null || settings?.maxPastTaskYears === ""
      ? null
      : Number.isFinite(Number(settings?.maxPastTaskYears))
        ? Math.min(
            50,
            Math.max(0, Math.floor(Number(settings?.maxPastTaskYears))),
          )
        : DEFAULT_PARSER_SETTINGS.maxPastTaskYears;

  return {
    confidenceMode,
    includeUndatedCandidates: Boolean(settings?.includeUndatedCandidates),
    maxTasks,
    blockedTitlePhrases,
    maxPastTaskYears,
  };
}

function loadParserSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PARSER_SETTINGS_KEY], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const merged = {
        ...DEFAULT_PARSER_SETTINGS,
        ...(result[PARSER_SETTINGS_KEY] || {}),
      };
      resolve(sanitizeParserSettings(merged));
    });
  });
}
