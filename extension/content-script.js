// Content script: scrape assignments and due dates using keyword-based parsing.

// Keywords that indicate a due date is present
const DUE_KEYWORDS =
  /\b(due|overdue|deadline|open until|available until|closes at|closes|closing|submit by|turn in by|due by|due on|due date)\b/i;

// Date patterns
const DATE_PATTERNS = {
  // "Mon, Jan 26, 2026" or "Jan 26, 2026" or "January 26, 2026"
  monthDayYear:
    /\b(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*[,.]?\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,.]?\s*(\d{4})\b/i,
  // "Jan 26" (no year)
  monthDay:
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  // ISO: 2026-01-26
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/,
  // relative: today, tomorrow
  relative: /\b(today|tomorrow)\b/i,
};

// Time pattern: handles "17:00", "5:00pm", "5:00 PM", "5 pm", "17:00 pm"
const TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;

(function () {
  if (window.__polychromeCaptureInjected) return;
  window.__polychromeCaptureInjected = true;

  const tasks = scrapeTasks();
  if (tasks.length === 0) return;

  chrome.runtime.sendMessage({
    type: "SCRAPED_TASKS",
    tasks: tasks.map((t) => ({
      title: t.title,
      description: t.description || "",
      dueDate: t.dueDate,
      labels: t.labels || ["capture"],
      url: location.href,
      raw: t.raw || "",
    })),
  });
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "REQUEST_SCRAPE") return;
  const tasks = scrapeTasks();
  if (tasks.length) {
    chrome.runtime.sendMessage({
      type: "SCRAPED_TASKS",
      tasks: tasks.map((t) => ({
        title: t.title,
        description: t.description || "",
        dueDate: t.dueDate,
        labels: t.labels || ["capture"],
        url: location.href,
        raw: t.raw || "",
      })),
    });
  }
  sendResponse({ ok: true, count: tasks.length });
});

function scrapeTasks() {
  const results = [];
  const seen = new Set();

  // Get all text nodes that might contain due date info
  const candidates = findCandidateElements();

  for (const { el, text } of candidates) {
    // Must contain a due-related keyword
    if (!DUE_KEYWORDS.test(text)) continue;

    const parsed = parseDateTimeFromText(text);
    if (!parsed) continue;

    const title = getTitle(el);
    const key = `${title}__${parsed}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      title,
      dueDate: parsed,
      raw: cleanRawText(text),
    });
  }

  return results;
}

function cleanRawText(text) {
  // Lines to remove (navigation, footer, UI elements)
  const junkPatterns = [
    /^!+$/,
    /^skip to content$/i,
    /^courses$/i,
    /^groups$/i,
    /^resources$/i,
    /^more$/i,
    /^home$/i,
    /^grades$/i,
    /^\d+$/, // standalone numbers like "35"
    /^start attempt$/i,
    /^english$/i,
    /^change language$/i,
    /^support$/i,
    /^privacy policy$/i,
    /^terms of use$/i,
    /^powerschool/i,
    /©\s*\d{4}/,
    /^assignment$/i,
    /^my document$/i,
    /^assignmentmy document$/i, // concatenated version
    /^assignment\s*my document$/i,
  ];

  const lines = text.split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    for (const pattern of junkPatterns) {
      if (pattern.test(trimmed)) return false;
    }
    return true;
  });

  // Remove consecutive duplicate lines
  const deduped = cleaned.filter(
    (line, i) => i === 0 || line.trim() !== cleaned[i - 1].trim(),
  );

  // Try to format as breadcrumb hierarchy
  return formatAsBreadcrumb(deduped);
}

function formatAsBreadcrumb(lines) {
  if (lines.length < 3) return lines.join("\n").trim();

  // Detect hierarchy patterns
  const hierarchy = [];
  const details = [];
  let foundAssignment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip if it looks like a person's name (two capitalized words, no special chars)
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(trimmed)) continue;

    // Course pattern: contains "Section" or class-like identifier
    if (!foundAssignment && /section|period|class|block/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    // Unit pattern
    if (!foundAssignment && /^unit\s+\d+/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    // Week pattern
    if (!foundAssignment && /^week\s+\d+/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    // Day of week
    if (
      !foundAssignment &&
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(
        trimmed,
      )
    ) {
      hierarchy.push(trimmed);
      continue;
    }

    // If we have hierarchy items and this doesn't match patterns, it's likely the assignment
    if (!foundAssignment && hierarchy.length > 0) {
      hierarchy.push(trimmed);
      foundAssignment = true;
      continue;
    }

    // Everything else goes to details
    details.push(trimmed);
  }

  // Build output
  const output = [];

  if (hierarchy.length > 0) {
    output.push(hierarchy.join(" > "));
  }

  if (details.length > 0) {
    output.push(""); // blank line
    output.push(...details);
  }

  return output.join("\n").trim();
}

function findCandidateElements() {
  const elements = document.querySelectorAll("*");
  const seen = new Set();
  const candidates = [];

  for (const el of elements) {
    if (!isVisible(el)) continue;

    const text = el.innerText?.trim();
    if (!text || text.length < 8 || text.length > 1000) continue;

    // Skip if we've already seen this exact text (dedupes nested elements)
    if (seen.has(text)) continue;
    seen.add(text);

    candidates.push({ el, text });
  }

  return candidates;
}

function isVisible(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  // Skip script, style, and other non-content elements
  const tag = el.tagName?.toLowerCase();
  if (
    ["script", "style", "noscript", "template", "svg", "path"].includes(tag)
  ) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  return true;
}

function getTitle(el) {
  // Try to find a heading nearby
  const h1 = document.querySelector("h1");
  if (h1 && h1.innerText?.trim()) return h1.innerText.trim();

  const h2 = document.querySelector("h2");
  if (h2 && h2.innerText?.trim()) return h2.innerText.trim();

  // Check parent for heading
  let cur = el;
  while (cur && cur !== document.body) {
    const heading = cur.querySelector("h1, h2, h3, h4");
    if (heading && heading.innerText?.trim()) return heading.innerText.trim();

    const prev = cur.previousElementSibling;
    if (prev?.matches?.("h1, h2, h3, h4") && prev.innerText?.trim()) {
      return prev.innerText.trim();
    }
    cur = cur.parentElement;
  }

  return document.title || "Captured task";
}

function parseDateTimeFromText(text) {
  const date = parseDate(text);
  if (!date) return null;

  const time = parseTime(text);
  if (time) {
    date.setHours(time.hours, time.minutes, 0, 0);
  }

  return date.toISOString();
}

function parseDate(text) {
  // Try ISO format first
  const isoMatch = text.match(DATE_PATTERNS.iso);
  if (isoMatch) {
    return new Date(
      parseInt(isoMatch[1]),
      parseInt(isoMatch[2]) - 1,
      parseInt(isoMatch[3]),
    );
  }

  // Try month day year: "Jan 26, 2026"
  const mdyMatch = text.match(DATE_PATTERNS.monthDayYear);
  if (mdyMatch) {
    const month = parseMonth(mdyMatch[1]);
    const day = parseInt(mdyMatch[2]);
    const year = parseInt(mdyMatch[3]);
    if (month !== -1) {
      return new Date(year, month, day);
    }
  }

  // Try month day without year: "Jan 26"
  const mdMatch = text.match(DATE_PATTERNS.monthDay);
  if (mdMatch) {
    const month = parseMonth(mdMatch[1]);
    const day = parseInt(mdMatch[2]);
    if (month !== -1) {
      const now = new Date();
      let year = now.getFullYear();
      const date = new Date(year, month, day);
      // If date is in the past, assume next year
      if (date < now) {
        date.setFullYear(year + 1);
      }
      return date;
    }
  }

  // Try relative dates
  const relMatch = text.toLowerCase().match(DATE_PATTERNS.relative);
  if (relMatch) {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (relMatch[1] === "tomorrow") {
      base.setDate(base.getDate() + 1);
    }
    return base;
  }

  return null;
}

function parseMonth(str) {
  const months = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const key = str.toLowerCase().slice(0, 3);
  return months[key] ?? -1;
}

function parseTime(text) {
  // Look for time near due keywords for better accuracy
  // Handles: "at 17:00", "at 17:00 pm", "at 5:00 PM", "until 5 pm"
  const keywordMatch = text.match(
    /(?:at|until|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );

  if (keywordMatch) {
    return normalizeTime(
      parseInt(keywordMatch[1]),
      parseInt(keywordMatch[2] || "0"),
      keywordMatch[3]?.toLowerCase(),
    );
  }

  // Find all times in the text
  const times = [];
  let match;
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
  while ((match = pattern.exec(text)) !== null) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2] || "0");
    const meridian = match[3]?.toLowerCase();

    // Skip numbers that don't look like times
    if (hours > 23) continue;
    // Skip bare numbers without minutes or meridian (like "26" in dates)
    if (!meridian && !match[2]) continue;

    times.push({ hours, minutes, meridian, index: match.index });
  }

  if (times.length === 0) return null;

  // Prefer times with explicit meridian
  const withMeridian = times.filter((t) => t.meridian);
  if (withMeridian.length > 0) {
    const t = withMeridian[0];
    return normalizeTime(t.hours, t.minutes, t.meridian);
  }

  // Otherwise take the first valid 24h time (has minutes, like 17:00)
  const t = times[0];
  return normalizeTime(t.hours, t.minutes, t.meridian);
}

function normalizeTime(hours, minutes, meridian) {
  // Handle 24-hour format: no meridian and hour > 12, OR hour > 12 with bogus "pm"
  if (hours > 12) {
    // Treat as 24h regardless of meridian (handles "17:00 pm")
    return { hours: hours > 23 ? hours % 24 : hours, minutes };
  }

  // Handle 12-hour format with meridian
  if (meridian === "pm" && hours < 12) {
    hours += 12;
  } else if (meridian === "am" && hours === 12) {
    hours = 0;
  }

  return { hours, minutes };
}
