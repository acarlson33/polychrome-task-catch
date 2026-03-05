# Polychrome Capture 1.0.0

Polychrome Capture `1.0.0` is the first stable release of the Chrome extension for extracting LMS tasks and saving them to Polychrome.

## What changed since 0.1.0 (user summary)

- Task capture is more accurate and less likely to pull unrelated page text.
- Results are easier to review because higher-confidence tasks appear first.
- You can now tune capture behavior directly in the popup without editing code.
- Old/stale due dates are filtered by default, with an override when needed.
- Save failures now provide clearer guidance, including sign-in recovery when your session expires.

## Highlights

- Major parser overhaul with staged extraction, scoring, and deduplication for improved reliability.
- Platform-agnostic capture strategy with adapter support (Schoology and Canvas) and tuning profiles.
- Better false-positive suppression for navigation/footer/comment noise and non-task labels.
- Improved due-date handling across semantic markup, common text formats, and stale-date filtering.
- Confidence-based ordering in popup results for faster manual review.

## New parser controls

- Confidence mode selector (`High Recall`, `Balanced`, `High Precision`).
- Option to include likely undated tasks.
- Runtime blocked-title phrase editor.
- Max past due age setting (default: 2 years, configurable or disabled).
- Parser debug panel with adapter info, thresholds, and reject reasons.

## Reliability and robustness improvements

- Mutation-based re-scrape support for dynamic LMS pages.
- Tab-scoped scrape caching in the service worker.
- Content-script handshake to prevent duplicate injection issues.
- Structured auth error handling (`401/403`) with sign-in recovery flow.
- Runtime and storage error guardrails for popup ↔ worker messaging.

## Notable filtering additions

- Excludes `Posted on: ...` and `Posted Today at ...` metadata from task titles.
- Adds explicit parser reject reason for posted metadata (`postedOnLabel`) visible in debug output.
- Strengthened closed/submission-disabled detection to avoid non-actionable captures.

## Compatibility

- Manifest V3 extension.
- Minimum Chrome version: `114`.

## Upgrade notes

- This release bumps extension version from `0.1.0` to `1.0.0` in `extension/manifest.json`.
- No migration steps are required for existing parser settings.
