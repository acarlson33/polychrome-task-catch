# Polychrome Capture (Chrome extension)

Quick scaffolding to scrape assignments (tuned for Schoology) and send them to Polychrome via `POST /api/tasks`.

## Description

Polychrome Capture is a Chrome extension that scans supported course pages, extracts upcoming assignments, and lets you review or edit them in a popup before saving them to Polychrome.

## Configure

1. Default production target is `https://polychrome.appwrite.network`; dev target is `http://localhost:3000`.
2. Use the popup “API” selector to switch between prod/dev (persisted in extension storage).
3. If you host elsewhere, change `PROD_ORIGIN`/`DEV_ORIGIN` in `service-worker.js` and add host permissions in `manifest.json`.
4. Ensure you are signed in to Polychrome in Chrome so the session cookie is present; the worker sends requests with `credentials: 'include'`.

## Load unpacked in Chrome

1. Open `chrome://extensions` → enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Navigate to a page (e.g., Schoology) and open the extension popup.

## Usage

- The content script auto-scrapes on page load. Click **Refresh** in the popup to rescan the current tab.
- Edit titles, due dates, or labels in the popup, then click **Save to Polychrome** to POST to `/api/tasks`.
- Failed saves show the API status code/message in the popup footer.

## Schoology-specific heuristics

- Reads upcoming items from selectors like `#upcoming-events .event`, `.upcoming-events .event-item`, pulling `.item-title`/`.event-title` and due text from `.due`, `.event-due`, `.date`, `.timestamp`.
- Reads course materials with selectors such as `.assignment-title`, `.item-assignment .title`, `.grading-item .title` and nearby `.due-date`, `.item-due-date`, `.date`.
- Dates are normalized to ISO; missing years roll to the future if the date already passed this year.

## API payload shape

Sent payload follows [`API_REQUIREMENTS.md`](../API_REQUIREMENTS.md):

```json
{
  "title": "…",
  "description": "Captured from <url>…",
  "status": "todo",
  "priority": "medium",
  "dueDate": "<ISO>",
  "labels": ["capture", "schoology"]
}
```

Adjust defaults in `service-worker.js` if you want different `status`, `priority`, or labels.
