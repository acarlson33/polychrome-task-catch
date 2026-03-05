# Polychrome Capture (Chrome extension)

Extension to scrape assignments and due dates from web pages and send them to Polychrome via `POST /api/tasks`.

## Release

- Current release: **1.0.0**
- Manifest: `extension/manifest.json`
- Target: Chrome MV3 (minimum Chrome 114)
- Release notes template: `RELEASE_NOTES_1.0.0.md`

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

- Opening the popup now triggers a fresh scrape of the active tab automatically; click **Refresh** anytime to force another pass.
- Use the **Parser** mode selector in the popup to tune confidence filtering (`High Recall`, `Balanced`, `High Precision`).
- Enable **Include likely tasks without parseable due date** when you want broader capture for pages with weak/ambiguous date markup.
- Use **Blocked title phrases** (one per line) to suppress noisy non-task titles at runtime without code changes.
- Use **Max past due age** to reject stale tasks older than 2 years by default; set a custom value or leave blank to disable the age limit.
- Edit titles, due dates, or labels in the popup, then click **Save to Polychrome** to POST to `/api/tasks`.
- Failed saves show the API status code/message in the popup footer.
- If your session is expired or missing (`401/403`), the extension shows an auth-required message and opens the Polychrome origin so you can sign in quickly.

## Capture strategy (platform-agnostic)

- Uses generic container discovery (`article`, `li`, `tr`, sections, task/event cards) instead of site-specific selectors.
- Combines semantic date sources (`time`, `datetime`, `data-due`, `data-date`, microdata props) with nearby text parsing.
- Supports common date formats: month names, ISO datetime, slash dates, and relative words (`today`, `tomorrow`).
- Re-scrapes on dynamic page updates via `MutationObserver`, reducing missed tasks on SPA-style sites.
- Stores scraped results per tab in the service worker so popup results stay aligned to the current page.
- Uses adapter hooks for known LMS platforms (currently Schoology + Canvas) as fallback boosts on top of the generic parser.

## Parser debug panel

- Open **Parser debug** in the popup footer to inspect adapter selection, candidate counts, threshold, and rejection reasons.
- Use this panel to tune parser mode and understand why items were excluded.
- Rejection reason **Posted-on label** indicates a candidate was only a `Posted on: ...` metadata line, not a real task title.

## Adapter registry (Phase 3)

- Adapters are now configuration-driven via a registry and per-adapter tuning profiles in `content-script.js`.
- Add a new platform by defining only adapter config (`id`, `matches`, selectors, and `tuning`) in `ADAPTER_DEFINITIONS`.
- Core parser pipeline stays unchanged; adapter tuning can override candidate cap, text-length cap, threshold offset, and score boosts.
- A copy-ready adapter template is available as `ADAPTER_TEMPLATE` in `content-script.js` and at runtime as `window.__polychromeAdapterTemplate`.
- Adapter tuning now supports `excludeKeywords`, `excludeSelectors`, and `candidateRootSelectors` to suppress sidebar/navigation noise (used by the Schoology adapter).
- Adapter tuning also supports `blockedTitlePhrases` for platform-specific title suppression without touching core parser logic.
- Adapter tuning supports `submissionDisabledPhrases` and `submissionDisabledSelectors` to drop closed/non-submittable assignments (used by the Schoology adapter).

## Confidence modes

- **High Recall**: lower threshold, captures more possible tasks (more manual cleanup).
- **Balanced**: default threshold for mixed recall/precision.
- **High Precision**: stricter threshold, keeps only high-confidence matches.

## API payload shape

Sent payload follows polychrome API requirements:

```json
{
  "title": "…",
  "description": "Captured from <url>…",
  "status": "todo",
  "priority": "medium",
  "dueDate": "<ISO>",
  "labels": ["capture", "web"]
}
```

Adjust defaults in `service-worker.js` if you want different `status`, `priority`, or labels.

## Release checklist (quick)

- Verify you are signed in to the production Polychrome origin.
- Open a supported LMS page and confirm **Refresh** captures expected tasks.
- Confirm parser debug output shows expected adapter and reject reasons.
- Save a small sample set and verify tasks appear in Polychrome.
- Package the `extension/` folder for distribution from Chrome Extensions page.
