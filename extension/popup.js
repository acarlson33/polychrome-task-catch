const taskListEl = document.getElementById("task-list");
const statusEl = document.getElementById("status");
const emptyEl = document.getElementById("empty");
const taskCountEl = document.getElementById("task-count");
const envSelect = document.getElementById("env");

document.getElementById("save").addEventListener("click", onSave);
document.getElementById("refresh").addEventListener("click", onRefresh);
envSelect.addEventListener("change", onEnvChange);

document.addEventListener("DOMContentLoaded", () => {
  loadEnv();
  loadTasks();
});

async function loadEnv() {
  const resp = await sendMessage({ type: "GET_ENV" });
  if (resp && resp.mode) envSelect.value = resp.mode;
  if (resp && resp.origin) status(resp.origin, "info");
}

async function onEnvChange() {
  const resp = await sendMessage({ type: "SET_ENV", mode: envSelect.value });
  if (resp && resp.origin) status(resp.origin, "info");
}

async function loadTasks() {
  hideStatus();
  const resp = await sendMessage({ type: "GET_LAST_TASKS" });
  renderTasks((resp && resp.tasks) || []);
}

async function onRefresh() {
  status("Rescanning page…", "info");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const injected = await ensureContentScript(tab.id);
  if (!injected.ok) {
    status(injected.message || "Cannot inject content script.", "error");
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_SCRAPE" });
  } catch (e) {
    status("Content script not ready. Reload the page.", "error");
    return;
  }
  // Give the content script a moment to send results to the worker.
  setTimeout(loadTasks, 350);
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

  tasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task";
    li.innerHTML = `
      <label>Title</label>
      <input class="title" type="text" value="${escapeHtml(task.title || "")}" />
      <label>Due</label>
      <input class="due" type="datetime-local" value="${toLocalInput(task.dueDate)}" />
      <label>Labels (comma)</label>
      <input class="labels" type="text" value="${escapeHtml((task.labels || []).join(", "))}" />
      <label>Notes</label>
      <textarea class="raw" rows="3">${escapeHtml(task.raw || task.description || "")}</textarea>
    `;
    taskListEl.appendChild(li);
  });
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return str
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
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function ensureContentScript(tabId) {
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
