const taskListEl = document.getElementById("task-list");
const statusEl = document.getElementById("status");
const emptyEl = document.getElementById("empty");
const taskCountEl = document.getElementById("task-count");
const envSelect = document.getElementById("env");
const confidenceModeEl = document.getElementById("confidence-mode");
const includeUndatedEl = document.getElementById("include-undated");
const blockedTitlePhrasesEl = document.getElementById("blocked-title-phrases");
const maxPastYearsEl = document.getElementById("max-past-years");
const parserDebugBodyEl = document.getElementById("parser-debug-body");

let parserSettings = {
  confidenceMode: "balanced",
  includeUndatedCandidates: false,
  maxTasks: 50,
  blockedTitlePhrases: [],
  maxPastTaskYears: 2,
};

document.getElementById("save").addEventListener("click", onSave);
document.getElementById("refresh").addEventListener("click", onRefresh);
envSelect.addEventListener("change", onEnvChange);
confidenceModeEl.addEventListener("change", onParserSettingsChanged);
includeUndatedEl.addEventListener("change", onParserSettingsChanged);
blockedTitlePhrasesEl.addEventListener("change", onParserSettingsChanged);
maxPastYearsEl.addEventListener("change", onParserSettingsChanged);

document.addEventListener("DOMContentLoaded", () => {
  loadEnv();
  loadParserSettings().then(() => {
    onRefresh({ silent: true });
  });
});

async function loadEnv() {
  const resp = await sendMessage({ type: "GET_ENV" });
  if (resp && resp.ok === false && resp.error) {
    status(`Env load failed: ${resp.error}`, "error");
    return;
  }
  if (resp && resp.mode) envSelect.value = resp.mode;
  if (resp && resp.origin) status(resp.origin, "info");
}

async function onEnvChange() {
  const resp = await sendMessage({ type: "SET_ENV", mode: envSelect.value });
  if (resp && resp.ok === false && resp.error) {
    status(`Env update failed: ${resp.error}`, "error");
    return;
  }
  if (resp && resp.origin) status(resp.origin, "info");
}

async function loadParserSettings() {
  const resp = await sendMessage({ type: "GET_PARSER_SETTINGS" });
  if (resp && resp.ok === false && resp.error) {
    status(`Parser settings load failed: ${resp.error}`, "error");
    return;
  }
  if (!resp || !resp.ok || !resp.settings) return;

  parserSettings = {
    ...parserSettings,
    ...resp.settings,
  };
  confidenceModeEl.value = parserSettings.confidenceMode;
  includeUndatedEl.checked = Boolean(parserSettings.includeUndatedCandidates);
  blockedTitlePhrasesEl.value = (parserSettings.blockedTitlePhrases || []).join(
    "\n",
  );
  maxPastYearsEl.value =
    parserSettings.maxPastTaskYears === null ||
    parserSettings.maxPastTaskYears === undefined
      ? ""
      : String(parserSettings.maxPastTaskYears);
}

async function onParserSettingsChanged() {
  const blockedTitlePhrases = String(blockedTitlePhrasesEl.value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const maxPastTaskYearsRaw = String(maxPastYearsEl.value || "").trim();
  const parsedMaxPastYears = Number(maxPastTaskYearsRaw);
  const maxPastTaskYears =
    maxPastTaskYearsRaw === ""
      ? null
      : Number.isFinite(parsedMaxPastYears)
        ? Math.min(50, Math.max(0, Math.floor(parsedMaxPastYears)))
        : parserSettings.maxPastTaskYears;

  if (maxPastTaskYearsRaw !== "" && !Number.isFinite(parsedMaxPastYears)) {
    status("Max past due age must be a number.", "error");
  }

  parserSettings = {
    ...parserSettings,
    confidenceMode: confidenceModeEl.value,
    includeUndatedCandidates: includeUndatedEl.checked,
    blockedTitlePhrases,
    maxPastTaskYears,
  };

  const saveResp = await sendMessage({
    type: "SET_PARSER_SETTINGS",
    settings: parserSettings,
  });
  if (saveResp && saveResp.ok === false && saveResp.error) {
    status(`Parser settings save failed: ${saveResp.error}`, "error");
    return;
  }

  onRefresh({ silent: false });
}

async function loadTasks() {
  hideStatus();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await sendMessage({
    type: "GET_LAST_TASKS",
    tabId: tab?.id,
  });
  renderTasks((resp && resp.tasks) || []);
  renderParserDebug(resp?.meta?.parser || null);
}

async function onRefresh(options = {}) {
  const { silent = false } = options;
  if (!silent) status("Rescanning page…", "info");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const injected = await ensureContentScript(tab.id);
  if (!injected.ok) {
    status(injected.message || "Cannot inject content script.", "error");
    return;
  }

  try {
    const response = await requestScrapeWithRetry(tab.id, parserSettings);
    if (response?.tasks) {
      renderTasks(response.tasks);
      renderParserDebug(response?.parser || null);
      if (!silent) hideStatus();
      return;
    }
  } catch (e) {
    status("Content script not ready. Reload the page.", "error");
    return;
  }
  setTimeout(loadTasks, 250);
}

async function requestScrapeWithRetry(tabId, settings, attempts = 3) {
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: "REQUEST_SCRAPE",
        parserSettings: settings,
      });
    } catch (error) {
      lastError = error;
      await sleep(120 + i * 150);
    }
  }

  throw lastError || new Error("Failed to request scrape");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function onSave() {
  const tasks = Array.from(taskListEl.querySelectorAll(".task")).map((el) => ({
    title: el.querySelector(".title").value.trim(),
    dueDate: el.querySelector(".due").value
      ? new Date(el.querySelector(".due").value).toISOString()
      : null,
    labels: el
      .querySelector(".labels")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    description: el.querySelector(".raw").value.trim(),
  }));

  status("Saving…", "info");
  const resp = await sendMessage({ type: "SAVE_TASKS", tasks });
  if (!resp || !resp.ok) {
    if (resp?.authRequired) {
      status("Sign in to Polychrome, then try Save again.", "error");
      if (resp.authUrl) {
        chrome.tabs.create({ url: resp.authUrl });
      }
      return;
    }

    status(`Failed: ${(resp && resp.error) || "unknown error"}`, "error");
    return;
  }
  status(
    `✓ Saved ${tasks.length} task${tasks.length !== 1 ? "s" : ""}!`,
    "success",
  );
  setTimeout(hideStatus, 3000);
}

function renderTasks(tasks) {
  taskListEl.innerHTML = "";
  if (tasks.length === 0) {
    emptyEl.classList.remove("hidden");
    taskCountEl.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  taskCountEl.classList.remove("hidden");
  taskCountEl.textContent = `${tasks.length} task${tasks.length !== 1 ? "s" : ""} found`;

  const orderedTasks = [...tasks].sort((a, b) => {
    const confidenceA = Number.isFinite(Number(a?.confidence))
      ? Number(a.confidence)
      : 0;
    const confidenceB = Number.isFinite(Number(b?.confidence))
      ? Number(b.confidence)
      : 0;

    if (confidenceB !== confidenceA) {
      return confidenceB - confidenceA;
    }

    if (a?.dueDate && b?.dueDate) {
      return new Date(a.dueDate) - new Date(b.dueDate);
    }

    if (a?.dueDate && !b?.dueDate) return -1;
    if (!a?.dueDate && b?.dueDate) return 1;
    return 0;
  });

  orderedTasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task";
    const confidenceLabel = task.confidenceLabel || "n/a";
    const dueState = task.hasDueDate === false ? "No due date" : "Due detected";
    const reasons = (task.reasons || []).join(", ");
    li.innerHTML = `
      <div class="task-meta">
        <span class="chip chip-${escapeHtml(confidenceLabel)}">${escapeHtml(confidenceLabel)} confidence</span>
        <span class="chip chip-subtle">${escapeHtml(dueState)}</span>
      </div>
      <label>Title</label>
      <input class="title" type="text" value="${escapeHtml(task.title || "")}" />
      <label>Due</label>
      <input class="due" type="datetime-local" value="${toLocalInput(task.dueDate)}" />
      <label>Labels (comma)</label>
      <input class="labels" type="text" value="${escapeHtml((task.labels || []).join(", "))}" />
      <label>Notes</label>
      <textarea class="raw" rows="3">${escapeHtml(task.raw || task.description || "")}</textarea>
      ${reasons ? `<small class="task-signals">Signals: ${escapeHtml(reasons)}</small>` : ""}
    `;
    taskListEl.appendChild(li);
  });
}

function renderParserDebug(parser) {
  if (!parserDebugBodyEl) return;

  if (!parser) {
    parserDebugBodyEl.textContent = "No parser run yet.";
    return;
  }

  const lines = [];
  lines.push(`Adapter: ${parser.adapter || "generic"}`);
  lines.push(`Candidates scanned: ${parser.candidateCount ?? "n/a"}`);
  lines.push(`Tasks kept: ${parser.keptCount ?? "n/a"}`);
  lines.push(`Tasks rejected: ${parser.rejectedCount ?? "n/a"}`);
  if (typeof parser.threshold === "number") {
    lines.push(`Confidence threshold: ${parser.threshold.toFixed(2)}`);
  }

  const tuning = parser.adapterTuning;
  const settings = parser.settings || {};
  lines.push(
    `Max past due age: ${
      settings.maxPastTaskYears === null ||
      settings.maxPastTaskYears === undefined
        ? "disabled"
        : `${settings.maxPastTaskYears} year(s)`
    }`,
  );

  if (tuning) {
    lines.push("");
    lines.push("Adapter tuning:");
    lines.push(`- Candidate cap: ${tuning.maxCandidatesOverride ?? "default"}`);
    lines.push(`- Text max length: ${tuning.textMaxLenOverride ?? "default"}`);
    lines.push(`- Threshold offset: ${tuning.thresholdOffset ?? 0}`);
    lines.push(
      `- Blocked title phrases: ${(tuning.blockedTitlePhrases || []).length}`,
    );
  }

  const rejectReasons = parser.rejectReasons || {};
  const rejectEntries = Object.entries(rejectReasons).filter(
    ([, value]) => Number(value) > 0,
  );

  if (rejectEntries.length > 0) {
    lines.push("");
    lines.push("Reject reasons:");
    rejectEntries.forEach(([key, value]) => {
      lines.push(`- ${humanizeReason(key)}: ${value}`);
    });
  }

  parserDebugBodyEl.textContent = lines.join("\n");
}

function humanizeReason(reason) {
  const labels = {
    noTitle: "No usable title",
    lowConfidence: "Low confidence",
    undatedDisabled: "Undated disabled",
    undatedLowConfidence: "Undated low confidence",
    adapterExcluded: "Adapter excluded",
    submissionsDisabled: "Submissions disabled",
    tooOldDueDate: "Due date too old",
    postedOnLabel: "Posted-on label",
  };
  return labels[reason] || reason;
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function status(text, type = "info") {
  statusEl.textContent = text;
  statusEl.className = "status";
  if (text) {
    statusEl.classList.remove("hidden");
    statusEl.classList.add(type);
  }
}

function hideStatus() {
  statusEl.classList.add("hidden");
  statusEl.textContent = "";
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PING_CAPTURE" });
    if (ping?.ok) return { ok: true, alreadyInjected: true };
  } catch (e) {
    // Not injected yet; continue to injection.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message };
  }
}
