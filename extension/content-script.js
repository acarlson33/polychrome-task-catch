// Content script: staged parser pipeline with confidence scoring.

const DUE_KEYWORDS =
  /\b(due|overdue|deadline|open until|available until|closes at|closes|closing|submit by|turn in by|due by|due on|due date|ends|end date|last date|final date|must submit|complete by|expires|available until)\b/i;
const TITLE_HINTS =
  /\b(assignment|task|quiz|project|homework|discussion|lab|exam|test|worksheet|activity|submission|module|lesson)\b/i;
const DATE_HINTS =
  /\b(due|deadline|by|until|on|tomorrow|today|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
const SUBMISSION_DISABLED_HINTS =
  /\b(not\s+accepting\s+submissions?|submissions?\s+(?:are\s+)?(?:disabled|closed|off|unavailable)|assignment\s+is\s+closed|no\s+longer\s+accepting\s+submissions?)\b/i;
const TITLE_NOISE =
  /^(comments?|add\s+comment|comment\s+thread|replies?|reply|discussion\s+board|attachments?|files?|materials?|resources?|information|overview|details|gradebook|grades?|rubric|submissions?|write\s+(?:a\s+)?comment|type\s+(?:a\s+)?comment|leave\s+(?:a\s+)?comment|there\s+(?:are|is)\s+no\s+comments?|privacy\s+policy|terms(?:\s+of\s+use)?|support|help\s+center|accessibility|copyright|posted(?:\s+on)?(?:\s*[:\-].*|\s+(?:today|tomorrow|yesterday|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}-\d{2}-\d{2}).*)?)$/i;

const CANDIDATE_SELECTORS = [
  "article",
  "li",
  "tr",
  "section",
  "td",
  "div",
  "[role='listitem']",
  "[role='row']",
  "[role='article']",
  "[class*='assign' i]",
  "[class*='task' i]",
  "[class*='event' i]",
  "[class*='due' i]",
  "time",
  "[datetime]",
  "[data-due]",
  "[data-date]",
  "[itemprop='dueDate']",
  "[itemprop='endDate']",
].join(",");

const TITLE_SELECTORS = [
  "[itemprop='name']",
  "[data-title]",
  "h1",
  "h2",
  "h3",
  "h4",
  ".title",
  ".name",
  "a",
].join(",");

const TEXT_MIN_LEN = 4;
const TEXT_MAX_LEN = 2200;
const MAX_CANDIDATES = 650;

const DEFAULT_ADAPTER_TUNING = {
  maxCandidatesOverride: null,
  textMaxLenOverride: null,
  thresholdOffset: 0,
  candidateRootSelectors: [],
  excludeSelectors: [],
  excludeKeywords: [],
  blockedTitlePhrases: [],
  submissionDisabledPhrases: [],
  submissionDisabledSelectors: [],
  scoreBoosts: {
    dueDate: 0,
    dueKeyword: 0,
    titleHint: 0,
    semantic: 0,
    adapter: 0,
  },
};

const DATE_PATTERNS = {
  monthDayYear:
    /\b(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*[,.]?\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,.]?\s*(\d{4})\b/i,
  monthDay:
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  iso: /\b(\d{4})-(\d{2})-(\d{2})(?:[t\s](\d{2}):(\d{2})(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)?\b/i,
  slash: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
  dashDMY: /\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/,
  relative: /\b(today|tomorrow)\b/i,
};

const DEFAULT_PARSER_SETTINGS = {
  confidenceMode: "balanced", // 'recall' | 'balanced' | 'precision'
  includeUndatedCandidates: false,
  maxTasks: 50,
  blockedTitlePhrases: [],
  maxPastTaskYears: 2,
};

const ADAPTER_TEMPLATE = {
  id: "platform-id",
  matches: (hostname) => /example\.com$/i.test(hostname),
  candidateSelectors: [".assignment-card", ".task-row", "[data-assignment-id]"],
  titleSelectors: [".assignment-title", ".title", "a"],
  dueSelectors: [".due-date", "time", "[datetime]", "[data-due]"],
  tuning: {
    maxCandidatesOverride: 800,
    textMaxLenOverride: 2600,
    thresholdOffset: -0.02,
    candidateRootSelectors: ["main", "#main-content"],
    excludeSelectors: ["aside", "nav", ".sidebar"],
    excludeKeywords: ["resources", "menu", "navigation"],
    blockedTitlePhrases: ["example tool name", "course resources"],
    submissionDisabledPhrases: ["not accepting submissions"],
    submissionDisabledSelectors: [".submission-closed", ".assignment-closed"],
    scoreBoosts: {
      dueDate: 0.03,
      dueKeyword: 0.01,
      titleHint: 0.01,
      semantic: 0.02,
      adapter: 0.03,
    },
  },
};

const ADAPTER_DEFINITIONS = [
  {
    id: "schoology",
    matches: (hostname) => /schoology\.com$/i.test(hostname),
    candidateSelectors: [
      "#upcoming-events .event, #upcoming-events li",
      ".upcoming-events .event-item, .upcoming-events li",
      ".assignment-item, .item-assignment, .grading-item",
    ],
    titleSelectors: [
      ".item-title",
      ".event-title",
      ".assignment-title",
      ".grading-item .title",
    ],
    dueSelectors: [
      ".due",
      ".event-due",
      ".date",
      ".timestamp",
      ".item-due-date",
      ".due-date",
    ],
    tuning: {
      maxCandidatesOverride: 850,
      textMaxLenOverride: 2800,
      thresholdOffset: -0.04,
      candidateRootSelectors: [
        "#main-content",
        "#main-inner",
        "#main",
        ".s-page-main",
        ".course-materials-left",
      ],
      excludeSelectors: [
        "#right-column",
        ".right-column",
        ".s-edge-side-menu",
        ".course-materials-right",
        "aside",
      ],
      excludeKeywords: [
        "grading periods",
        "brainpop",
        "information",
        "course options",
        "members",
      ],
      blockedTitlePhrases: [
        "stemscopes 4.0 and math nation",
        "Third 9 Weeks",
        "Second 9 Weeks",
        "First 9 Weeks",
        "Skip to Content",
        "Course Profile",
        "Current Menu ItemMaterials DropdownMaterials",
        "Britannica School",
        "Canva for Education",
        "LockDown Browser",
        "Access Pearson",
        "Google Gemini",
        "Magic School",
      ],
      submissionDisabledPhrases: [
        "this assignment is not accepting submissions",
        "not accepting submissions",
        "assignment is closed",
        "no longer accepting submissions",
      ],
      submissionDisabledSelectors: [
        ".submission-status",
        ".submission-closed",
        ".assignment-closed",
        ".not-accepting-submissions",
      ],
      scoreBoosts: {
        dueDate: 0.04,
        dueKeyword: 0.02,
        titleHint: 0,
        semantic: 0.03,
        adapter: 0.03,
      },
    },
  },
  {
    id: "canvas",
    matches: (hostname) => /instructure\.com$/i.test(hostname),
    candidateSelectors: [
      ".PlannerItem, .planner-item",
      ".assignment, .assignment_group .assignment",
      ".todo-list-item",
    ],
    titleSelectors: [".PlannerItem__Title", ".assignment_name", ".title", "a"],
    dueSelectors: [
      ".PlannerItem-styles__due",
      ".due_date",
      ".details",
      "time",
      "[datetime]",
    ],
    tuning: {
      maxCandidatesOverride: 900,
      textMaxLenOverride: 3000,
      thresholdOffset: -0.03,
      candidateRootSelectors: ["#content", "main", ".ic-Layout-contentMain"],
      excludeSelectors: [".ic-app-nav-toggle-and-crumbs", ".ic-DashboardCard"],
      excludeKeywords: ["to do", "help", "account"],
      scoreBoosts: {
        dueDate: 0.03,
        dueKeyword: 0.01,
        titleHint: 0.02,
        semantic: 0.03,
        adapter: 0.03,
      },
    },
  },
];

const ADAPTER_REGISTRY = createAdapterRegistry(ADAPTER_DEFINITIONS);
window.__polychromeAdapterTemplate = ADAPTER_TEMPLATE;
window.__polychromeRegisterAdapter = (definition) =>
  registerAdapter(ADAPTER_REGISTRY, definition);

(function initCapture() {
  if (window.__polychromeCaptureInjected) return;
  window.__polychromeCaptureInjected = true;

  let lastSignature = "";
  let observerTimer = null;
  let activeSettings = { ...DEFAULT_PARSER_SETTINGS };

  function getSignature(tasks) {
    return JSON.stringify(
      tasks.map((task) => ({
        title: task.title,
        dueDate: task.dueDate,
        confidence: task.confidence,
      })),
    );
  }

  function emitScrapeResult(result) {
    const tasks = result.tasks || [];
    const diagnostics = result.diagnostics || {};

    const payload = tasks.map((task) => ({
      title: task.title,
      description: task.description || "",
      dueDate: task.dueDate || null,
      labels: task.labels || ["capture", "web"],
      url: location.href,
      raw: task.raw || "",
      confidence: task.confidence,
      confidenceLabel: task.confidenceLabel,
      reasons: task.reasons || [],
      hasDueDate: Boolean(task.dueDate),
    }));

    try {
      chrome.runtime.sendMessage(
        {
          type: "SCRAPED_TASKS",
          tasks: payload,
          parser: {
            settings: activeSettings,
            candidateCount: diagnostics.candidateCount || 0,
            keptCount: diagnostics.keptCount || payload.length,
            rejectedCount: diagnostics.rejectedCount || 0,
            adapter: diagnostics.adapter || "generic",
            threshold: diagnostics.threshold,
            rejectReasons: diagnostics.rejectReasons || {},
          },
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    } catch (error) {
      // Ignore transient runtime messaging failures (e.g., extension reload).
    }

    return payload;
  }

  function scrapeAndEmitIfChanged() {
    const result = scrapeTasks(activeSettings);
    const tasks = result.tasks;
    const signature = getSignature(tasks);
    if (signature === lastSignature) return tasks;

    lastSignature = signature;
    emitScrapeResult(result);
    return tasks;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "PING_CAPTURE") {
      sendResponse({ ok: true, injected: true });
      return false;
    }

    if (!msg || msg.type !== "REQUEST_SCRAPE") return false;

    try {
      activeSettings = sanitizeParserSettings(
        msg.parserSettings || activeSettings,
      );
      const result = scrapeTasks(activeSettings);
      const tasks = result.tasks;
      lastSignature = getSignature(tasks);
      const payload = emitScrapeResult(result);

      sendResponse({
        ok: true,
        count: payload.length,
        tasks: payload,
        parser: {
          settings: activeSettings,
          candidateCount: result.diagnostics.candidateCount,
          keptCount: result.diagnostics.keptCount,
          rejectedCount: result.diagnostics.rejectedCount,
          adapter: result.diagnostics.adapter,
          threshold: result.diagnostics.threshold,
          rejectReasons: result.diagnostics.rejectReasons,
        },
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || "Failed to scrape tasks.",
      });
    }

    return false;
  });

  scrapeAndEmitIfChanged();

  const observer = new MutationObserver(() => {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      scrapeAndEmitIfChanged();
    }, 500);
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();

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
    : DEFAULT_PARSER_SETTINGS.blockedTitlePhrases;

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

function scrapeTasks(settings) {
  const parserSettings = sanitizeParserSettings(settings);
  const adapterProfile = resolveAdapterProfile(window.location.hostname);
  const effectiveBlockedTitlePhrases = mergeBlockedTitlePhrases(
    adapterProfile.tuning.blockedTitlePhrases,
    parserSettings.blockedTitlePhrases,
  );

  adapterProfile.effectiveBlockedTitlePhrases = effectiveBlockedTitlePhrases;
  const candidates = collectCandidates(adapterProfile);
  window.__polyCaptureLastCandidateCount = candidates.length;

  const scored = [];
  const rejectReasons = {
    noTitle: 0,
    lowConfidence: 0,
    undatedDisabled: 0,
    undatedLowConfidence: 0,
    adapterExcluded: 0,
    submissionsDisabled: 0,
    tooOldDueDate: 0,
    postedOnLabel: 0,
  };

  for (const el of candidates) {
    if (isAdapterExcluded(el, adapterProfile)) {
      rejectReasons.adapterExcluded += 1;
      continue;
    }

    const extracted = extractCandidate(el, adapterProfile);
    if (!extracted) {
      rejectReasons.noTitle += 1;
      continue;
    }
    if (extracted.rejectReason) {
      if (rejectReasons[extracted.rejectReason] !== undefined) {
        rejectReasons[extracted.rejectReason] += 1;
      } else {
        rejectReasons.noTitle += 1;
      }
      continue;
    }

    const score = scoreCandidate(extracted, adapterProfile);
    extracted.confidence = score;
    extracted.confidenceLabel = confidenceLabel(score);

    const decision = evaluateCandidate(
      extracted,
      parserSettings,
      adapterProfile,
    );
    if (!decision.keep) {
      if (decision.reason && rejectReasons[decision.reason] !== undefined) {
        rejectReasons[decision.reason] += 1;
      }
      continue;
    }

    scored.push(extracted);
  }

  const deduped = dedupeTasks(scored)
    .sort((a, b) => sortByDueDateThenConfidence(a, b))
    .slice(0, parserSettings.maxTasks);

  const tasks = deduped.map((task) => ({
    title: task.title,
    dueDate: task.dueDate || null,
    raw: task.raw,
    labels: ["capture", "web"],
    confidence: task.confidence,
    confidenceLabel: task.confidenceLabel,
    reasons: task.reasons,
    hasDueDate: task.hasDueDate,
  }));

  return {
    tasks,
    diagnostics: {
      adapter: adapterProfile.id,
      candidateCount: candidates.length,
      keptCount: tasks.length,
      rejectedCount: Math.max(0, candidates.length - tasks.length),
      threshold: Math.max(
        0.2,
        Math.min(
          0.95,
          thresholdForMode(parserSettings.confidenceMode) +
            adapterProfile.tuning.thresholdOffset,
        ),
      ),
      adapterTuning: {
        maxCandidatesOverride: adapterProfile.tuning.maxCandidatesOverride,
        textMaxLenOverride: adapterProfile.tuning.textMaxLenOverride,
        thresholdOffset: adapterProfile.tuning.thresholdOffset,
        candidateRootSelectors: adapterProfile.tuning.candidateRootSelectors,
        excludeSelectors: adapterProfile.tuning.excludeSelectors,
        excludeKeywords: adapterProfile.tuning.excludeKeywords,
        blockedTitlePhrases: effectiveBlockedTitlePhrases,
        submissionDisabledPhrases:
          adapterProfile.tuning.submissionDisabledPhrases,
        submissionDisabledSelectors:
          adapterProfile.tuning.submissionDisabledSelectors,
      },
      rejectReasons,
    },
  };
}

function mergeBlockedTitlePhrases(adapterList, runtimeList) {
  const unique = new Set();

  for (const list of [adapterList, runtimeList]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const normalized = String(value || "").trim();
      if (!normalized) continue;
      unique.add(normalized);
    }
  }

  return Array.from(unique);
}

function createAdapterRegistry(definitions) {
  const registry = new Map();
  for (const definition of definitions || []) {
    registerAdapter(registry, definition);
  }
  return registry;
}

function registerAdapter(registry, definition) {
  if (!registry || !definition || !definition.id || !definition.matches) return;

  const normalized = {
    id: definition.id,
    matches: definition.matches,
    candidateSelectors: Array.isArray(definition.candidateSelectors)
      ? definition.candidateSelectors
      : [],
    titleSelectors: Array.isArray(definition.titleSelectors)
      ? definition.titleSelectors
      : [],
    dueSelectors: Array.isArray(definition.dueSelectors)
      ? definition.dueSelectors
      : [],
    tuning: {
      ...DEFAULT_ADAPTER_TUNING,
      ...(definition.tuning || {}),
      candidateRootSelectors: Array.isArray(
        definition.tuning?.candidateRootSelectors,
      )
        ? definition.tuning.candidateRootSelectors
        : DEFAULT_ADAPTER_TUNING.candidateRootSelectors,
      excludeSelectors: Array.isArray(definition.tuning?.excludeSelectors)
        ? definition.tuning.excludeSelectors
        : DEFAULT_ADAPTER_TUNING.excludeSelectors,
      excludeKeywords: Array.isArray(definition.tuning?.excludeKeywords)
        ? definition.tuning.excludeKeywords
        : DEFAULT_ADAPTER_TUNING.excludeKeywords,
      blockedTitlePhrases: Array.isArray(definition.tuning?.blockedTitlePhrases)
        ? definition.tuning.blockedTitlePhrases
        : DEFAULT_ADAPTER_TUNING.blockedTitlePhrases,
      submissionDisabledPhrases: Array.isArray(
        definition.tuning?.submissionDisabledPhrases,
      )
        ? definition.tuning.submissionDisabledPhrases
        : DEFAULT_ADAPTER_TUNING.submissionDisabledPhrases,
      submissionDisabledSelectors: Array.isArray(
        definition.tuning?.submissionDisabledSelectors,
      )
        ? definition.tuning.submissionDisabledSelectors
        : DEFAULT_ADAPTER_TUNING.submissionDisabledSelectors,
      scoreBoosts: {
        ...DEFAULT_ADAPTER_TUNING.scoreBoosts,
        ...(definition.tuning?.scoreBoosts || {}),
      },
    },
  };

  registry.set(normalized.id, normalized);
}

function resolveAdapterProfile(hostname) {
  const fallback = {
    id: "generic",
    adapter: null,
    tuning: { ...DEFAULT_ADAPTER_TUNING },
  };

  for (const adapter of ADAPTER_REGISTRY.values()) {
    if (adapter.matches(hostname)) {
      return {
        id: adapter.id,
        adapter,
        tuning: adapter.tuning,
      };
    }
  }

  return fallback;
}

function collectCandidates(adapterProfile) {
  const adapter = adapterProfile?.adapter;
  const textMaxLen = adapterProfile?.tuning?.textMaxLenOverride || TEXT_MAX_LEN;
  const maxCandidates =
    adapterProfile?.tuning?.maxCandidatesOverride || MAX_CANDIDATES;

  const adapterSelectors = adapter?.candidateSelectors?.join(",") || "";
  const selector = adapterSelectors
    ? `${CANDIDATE_SELECTORS},${adapterSelectors}`
    : CANDIDATE_SELECTORS;
  const nodes = queryCandidateNodes(selector, adapterProfile);
  const candidates = [];
  const seen = new Set();

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (!isVisible(node)) continue;

    const text = getCandidateText(node);
    if (!text || text.length < TEXT_MIN_LEN || text.length > textMaxLen) {
      continue;
    }

    const fingerprint = fingerprintCandidate(node, text);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    if (!maybeRelevant(node, text, adapterProfile)) continue;

    candidates.push(node);
    if (candidates.length >= maxCandidates) break;
  }

  return candidates;
}

function queryCandidateNodes(selector, adapterProfile) {
  const roots = resolveCandidateRoots(adapterProfile);
  if (roots.length === 0) {
    return Array.from(document.querySelectorAll(selector));
  }

  const deduped = new Set();
  for (const root of roots) {
    const matches = root.querySelectorAll(selector);
    for (const node of matches) {
      deduped.add(node);
    }
  }

  return Array.from(deduped);
}

function resolveCandidateRoots(adapterProfile) {
  const selectors = adapterProfile?.tuning?.candidateRootSelectors || [];
  if (!selectors.length) return [];

  const roots = [];
  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (found) roots.push(found);
  }
  return roots;
}

function isAdapterExcluded(el, adapterProfile) {
  const tuning = adapterProfile?.tuning;
  if (!tuning) return false;

  const excludeSelectors = tuning.excludeSelectors || [];
  for (const selector of excludeSelectors) {
    if (el.closest(selector)) return true;
  }

  const excludeKeywords = tuning.excludeKeywords || [];
  if (!excludeKeywords.length) return false;

  const text = getCandidateText(el).toLowerCase();
  for (const keyword of excludeKeywords) {
    if (!keyword) continue;
    if (text.includes(String(keyword).toLowerCase())) {
      return true;
    }
  }

  return false;
}

function maybeRelevant(el, text, adapterProfile) {
  const adapter = adapterProfile?.adapter;
  if (DUE_KEYWORDS.test(text)) return true;
  if (TITLE_HINTS.test(text)) return true;
  if (DATE_HINTS.test(text) && parseDateTimeFromText(text)) return true;
  if (extractSemanticDate(el)) return true;
  if (adapter) {
    const titleMatch = adapter.titleSelectors?.some((selector) =>
      Boolean(el.querySelector(selector)),
    );
    const dueMatch = adapter.dueSelectors?.some((selector) =>
      Boolean(el.querySelector(selector)),
    );
    if (titleMatch && dueMatch) return true;
  }
  return false;
}

function extractCandidate(el, adapterProfile) {
  const adapter = adapterProfile?.adapter;
  const sourceText = getCandidateText(el);
  const rawText = cleanRawText(sourceText);
  const title = sanitizeTitleText(extractTitle(el, rawText, adapterProfile));
  if (!title || title.length < 2) {
    if (hasPostedOnOnlySignal(sourceText)) {
      return { rejectReason: "postedOnLabel" };
    }
    return null;
  }

  const dueInfo = extractDueInfo(el, rawText, adapterProfile);
  const hasDueDate = Boolean(dueInfo?.iso);
  const submissionsDisabled = detectSubmissionDisabled(
    el,
    rawText,
    adapterProfile,
  );

  const reasons = [];
  if (hasDueDate) reasons.push(`due:${dueInfo.source}`);
  if (submissionsDisabled) reasons.push("submission-disabled");
  if (DUE_KEYWORDS.test(rawText)) reasons.push("due-keyword");
  if (TITLE_HINTS.test(rawText) || TITLE_HINTS.test(title))
    reasons.push("title-hint");
  if (hasSemanticSignals(el)) reasons.push("semantic");
  if (adapter) reasons.push(`adapter:${adapter.id}`);

  return {
    title,
    dueDate: dueInfo?.iso || null,
    hasDueDate,
    submissionsDisabled,
    raw: rawText,
    reasons,
    sourceElement: el,
  };
}

function hasPostedOnOnlySignal(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => sanitizeTitleText(line).trim())
    .filter(Boolean);

  if (!lines.length) return false;

  let postedOnCount = 0;
  let meaningfulNonPostedCount = 0;

  for (const line of lines) {
    if (isPostedOnLabel(line)) {
      postedOnCount += 1;
      continue;
    }

    const normalized = normalizeNoiseText(line);
    if (!normalized) continue;
    if (looksLikeDateOnly(line)) continue;
    if (isPlaceholderLikeText(line)) continue;
    if (TITLE_NOISE.test(normalized)) continue;

    meaningfulNonPostedCount += 1;
    if (meaningfulNonPostedCount > 0) break;
  }

  return postedOnCount > 0 && meaningfulNonPostedCount === 0;
}

function detectSubmissionDisabled(el, rawText, adapterProfile) {
  if (SUBMISSION_DISABLED_HINTS.test(rawText || "")) return true;

  const tuning = adapterProfile?.tuning;
  if (!tuning) return false;

  const phraseList = tuning.submissionDisabledPhrases || [];
  if (phraseList.length) {
    const parent =
      el.closest?.(
        "article, li, tr, section, [role='listitem'], [role='row']",
      ) || el.parentElement;
    const combined = [
      rawText,
      getCandidateText(el),
      parent?.innerText || "",
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("title") || "",
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    for (const phrase of phraseList) {
      const normalizedPhrase = String(phrase || "")
        .trim()
        .toLowerCase();
      if (!normalizedPhrase) continue;
      if (combined.includes(normalizedPhrase)) return true;
    }
  }

  const selectorList = tuning.submissionDisabledSelectors || [];
  for (const selector of selectorList) {
    if (!selector) continue;
    const node = el.matches?.(selector) ? el : el.querySelector?.(selector);
    if (!node) continue;

    if (isDisabledIndicatorNode(node)) return true;
  }

  const disabledSubmitControl = el.querySelector?.(
    "button[disabled], input[type='submit'][disabled], button[aria-disabled='true'], [role='button'][aria-disabled='true']",
  );
  if (disabledSubmitControl) {
    const controlText = normalizeNoiseText(
      disabledSubmitControl.innerText ||
        disabledSubmitControl.textContent ||
        disabledSubmitControl.getAttribute?.("aria-label") ||
        "",
    );

    if (/\b(submit|turn\s*in|resubmit|upload)\b/i.test(controlText)) {
      return true;
    }
  }

  return false;
}

function isDisabledIndicatorNode(node) {
  if (!node) return false;

  const ariaDisabled =
    node.getAttribute?.("aria-disabled") === "true" ||
    node.getAttribute?.("disabled") !== null;

  const className = String(node.className || "").toLowerCase();
  const classLooksDisabled =
    className.includes("disabled") ||
    className.includes("closed") ||
    className.includes("not-accepting");

  const text = normalizeNoiseText(
    node.innerText || node.textContent || node.getAttribute?.("title") || "",
  );

  if (SUBMISSION_DISABLED_HINTS.test(text)) return true;
  if (ariaDisabled && /\b(submit|turn\s*in|resubmit|upload)\b/i.test(text)) {
    return true;
  }

  return (
    classLooksDisabled && /\b(submission|submit|turn\s*in|closed)\b/i.test(text)
  );
}

function extractTitle(el, rawText, adapterProfile) {
  const adapter = adapterProfile?.adapter;
  if (adapter?.titleSelectors?.length) {
    const adapterCandidates = [];
    for (const selector of adapter.titleSelectors) {
      const nodes = el.querySelectorAll?.(selector) || [];
      for (const node of nodes) {
        const adapterTitle = node?.innerText?.trim();
        if (isUsefulTitle(adapterTitle, adapterProfile)) {
          adapterCandidates.push(adapterTitle);
        }
      }
    }
    const bestAdapter = pickBestTitleCandidate(
      adapterCandidates,
      adapterProfile,
    );
    if (bestAdapter) return bestAdapter;
  }

  const ownCandidates = Array.from(el.querySelectorAll?.(TITLE_SELECTORS) || [])
    .map((node) => node?.innerText?.trim())
    .filter(Boolean);
  const bestOwn = pickBestTitleCandidate(ownCandidates, adapterProfile);
  if (bestOwn) return bestOwn;

  const localContainer =
    el.closest?.(
      "article, li, tr, section, [role='listitem'], [role='row'], div",
    ) || el;

  const localCandidates = Array.from(
    localContainer.querySelectorAll?.(TITLE_SELECTORS) || [],
  )
    .map((node) => node?.innerText?.trim())
    .filter(Boolean);
  const bestLocal = pickBestTitleCandidate(localCandidates, adapterProfile);
  if (bestLocal) return bestLocal;

  const lines = (rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length > 2);

  const bestLine = pickBestTitleCandidate(
    lines.filter(
      (line) =>
        !DUE_KEYWORDS.test(line) &&
        !looksLikeDateOnly(line) &&
        !isPlaceholderLikeText(line),
    ),
    adapterProfile,
  );
  if (isUsefulTitle(bestLine, adapterProfile)) return bestLine;

  return getPageContextTitle(el, adapterProfile);
}

function isUsefulTitle(text, adapterProfile) {
  if (!text) return false;
  if (text.length < 2) return false;
  if (text.length > 180) return false;
  if (looksLikeDateOnly(text)) return false;
  if (isPostedOnLabel(text)) return false;
  if (isGenericScheduleLabel(text)) return false;
  if (isLikelyCourseName(text)) return false;
  if (isBlockedByAdapterTitlePhrase(text, adapterProfile)) return false;
  if (TITLE_NOISE.test(normalizeNoiseText(text))) return false;
  if (isPlaceholderLikeText(text)) return false;
  return true;
}

function isBlockedByAdapterTitlePhrase(text, adapterProfile) {
  if (!text) return false;

  const list =
    adapterProfile?.effectiveBlockedTitlePhrases ||
    adapterProfile?.tuning?.blockedTitlePhrases ||
    [];
  if (!Array.isArray(list) || list.length === 0) return false;

  const normalized = normalizeNoiseText(text);
  if (!normalized) return false;

  for (const phrase of list) {
    const candidate = normalizeNoiseText(String(phrase || ""));
    if (!candidate) continue;
    if (normalized === candidate || normalized.includes(candidate)) {
      return true;
    }
  }

  return false;
}

function isGenericScheduleLabel(text) {
  const normalized = normalizeNoiseText(text);
  if (!normalized) return false;

  if (/^week\s+\d+$/i.test(normalized)) return true;
  if (/^unit\s+\d+$/i.test(normalized)) return true;
  if (/^quarter\s+\d+$/i.test(normalized)) return true;
  if (/^(marking\s+period|grading\s+period|term)\s+\d+$/i.test(normalized)) {
    return true;
  }
  if (
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(
      normalized,
    )
  ) {
    return true;
  }

  return false;
}

function isLikelyCourseName(text) {
  const normalized = normalizeNoiseText(text);
  if (!normalized) return false;

  if (
    /^stemscopes(?:\s*\d+(?:\.\d+)?)?\s+and\s+math\s+nation$/i.test(normalized)
  ) {
    return true;
  }

  if (/\b(section|period|block)\s+[a-z0-9-]+$/i.test(normalized)) return true;
  if (/\b(?:course|class)\s*:\s*[a-z0-9].*$/i.test(normalized)) return true;

  const hasSubjectLikePrefix =
    /^[a-z][a-z0-9\s&/.+-]{2,}\s*:\s*(section|period|block)\s+[a-z0-9-]+$/i.test(
      normalized,
    );
  if (hasSubjectLikePrefix) return true;

  return false;
}

function sanitizeTitleText(text) {
  if (!text) return "";

  return text
    .replace(/\s+/g, " ")
    .replace(/^\|+\s*/, "")
    .replace(/\s*\|\s*schoology\s*$/i, "")
    .replace(/\s*[\-|–—]\s*schoology\s*$/i, "")
    .replace(/\s*\|+\s*$/g, "")
    .trim();
}

function pickBestTitleCandidate(candidates, adapterProfile) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const score = scoreTitleCandidate(candidate, adapterProfile);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best || bestScore <= 0) return null;
  return best.trim();
}

function scoreTitleCandidate(text, adapterProfile) {
  if (!isUsefulTitle(text, adapterProfile)) return -10;

  const normalized = text.trim();
  const normalizedNoise = normalizeNoiseText(text);
  let score = 0;

  if (normalized.length >= 6) score += 1;
  if (normalized.length >= 12) score += 1;
  if (TITLE_HINTS.test(normalized)) score += 2;
  if (/[:\-]/.test(normalized)) score += 0.5;
  if (/\d/.test(normalized)) score += 0.5;
  if (DATE_HINTS.test(normalized)) score -= 1;
  if (TITLE_NOISE.test(normalizedNoise)) score -= 4;
  if (isBlockedByAdapterTitlePhrase(normalized, adapterProfile)) score -= 6;
  if (isPlaceholderLikeText(normalized)) score -= 6;

  return score;
}

function normalizeNoiseText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\(required\)\s*$/i, "")
    .replace(/[.!?…:;]+$/g, "")
    .replace(/[\s*•·]+$/g, "")
    .replace(/[.!?…:;]+$/g, "")
    .trim();
}

function isPlaceholderLikeText(text) {
  if (!text) return false;
  const normalized = normalizeNoiseText(text);

  if (/^there\s+(?:are|is)\s+no\s+comments?$/.test(normalized)) return true;

  return /^(write|add|type|leave|start|enter)\s+(?:your\s+|a\s+)?comments?$/.test(
    normalized,
  );
}

function isPostedOnLabel(text) {
  if (!text) return false;
  const normalized = normalizeNoiseText(text);
  if (/^posted\s+on(?:\s*[:\-].+)?$/i.test(normalized)) return true;

  return /^posted(?:\s*[:\-])?\s+(?:today|tomorrow|yesterday|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{4}-\d{2}-\d{2}).*$/i.test(
    normalized,
  );
}

function getPageContextTitle(el, adapterProfile) {
  let current = el;
  while (current && current !== document.body) {
    const heading = current.querySelector?.("h1, h2, h3, h4");
    const headingText = heading?.innerText?.trim();
    if (
      isUsefulTitle(headingText, adapterProfile) &&
      !DUE_KEYWORDS.test(headingText) &&
      !TITLE_NOISE.test(headingText)
    ) {
      return headingText;
    }
    current = current.parentElement;
  }

  const pageTitle = document.title?.trim();
  return pageTitle || "Captured task";
}

function extractDueInfo(el, rawText, adapterProfile) {
  const adapter = adapterProfile?.adapter;
  if (adapter?.dueSelectors?.length) {
    for (const selector of adapter.dueSelectors) {
      const dueNode = el.querySelector?.(selector);
      if (!dueNode) continue;
      const value =
        dueNode.getAttribute?.("datetime") ||
        dueNode.getAttribute?.("data-date") ||
        dueNode.getAttribute?.("data-due") ||
        dueNode.innerText ||
        dueNode.textContent ||
        "";
      const parsed = parseDateTimeFromText(value);
      if (parsed) {
        return { iso: parsed, source: `adapter:${adapter.id}` };
      }
    }
  }

  const semantic = extractSemanticDate(el);
  if (semantic) return semantic;

  const fromOwnText = parseDateTimeFromText(rawText);
  if (fromOwnText) return { iso: fromOwnText, source: "text" };

  const parent =
    el.closest?.("article, li, tr, section, [role='listitem'], [role='row']") ||
    el.parentElement;

  const nearbyText = [
    rawText,
    parent?.innerText || "",
    el.previousElementSibling?.innerText || "",
    el.nextElementSibling?.innerText || "",
  ]
    .filter(Boolean)
    .join("\n");

  const fromNearby = parseDateTimeFromText(nearbyText);
  if (fromNearby) return { iso: fromNearby, source: "nearby" };

  return null;
}

function extractSemanticDate(el) {
  const nodes = [
    el,
    ...(el.querySelectorAll?.(
      "time,[datetime],[data-due],[data-date],[itemprop='endDate'],[itemprop='dueDate']",
    ) || []),
  ];

  for (const node of nodes) {
    const values = [
      node.getAttribute?.("datetime"),
      node.getAttribute?.("data-due"),
      node.getAttribute?.("data-date"),
      node.getAttribute?.("content"),
      node.textContent,
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("title"),
    ].filter(Boolean);

    for (const value of values) {
      const parsed = parseDateTimeFromText(value);
      if (parsed) {
        return { iso: parsed, source: "semantic" };
      }
    }
  }

  return null;
}

function hasSemanticSignals(el) {
  if (el.matches?.("time,[datetime],[data-due],[data-date]")) return true;
  const match = el.querySelector?.(
    "time,[datetime],[data-due],[data-date],[itemprop='dueDate'],[itemprop='endDate']",
  );
  return Boolean(match);
}

function scoreCandidate(task, adapterProfile) {
  const boosts =
    adapterProfile?.tuning?.scoreBoosts || DEFAULT_ADAPTER_TUNING.scoreBoosts;
  let score = 0;

  if (task.hasDueDate) {
    if (task.reasons.includes("due:semantic")) score += 0.45;
    else if (task.reasons.includes("due:nearby")) score += 0.33;
    else score += 0.3;
    score += boosts.dueDate;
  }

  if (task.reasons.includes("due-keyword")) score += 0.2 + boosts.dueKeyword;
  if (task.reasons.includes("title-hint")) score += 0.15 + boosts.titleHint;
  if (task.reasons.includes("semantic")) score += 0.14 + boosts.semantic;
  if (task.reasons.some((reason) => reason.startsWith("adapter:"))) {
    score += boosts.adapter;
  }

  if (task.title && task.title.length > 4 && task.title.length < 120) {
    score += 0.1;
  }

  if (task.raw && task.raw.length > 25) {
    score += 0.05;
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function evaluateCandidate(task, settings, adapterProfile) {
  if (task.submissionsDisabled) {
    return { keep: false, reason: "submissionsDisabled" };
  }

  if (isDueDateTooOld(task.dueDate, settings.maxPastTaskYears)) {
    return { keep: false, reason: "tooOldDueDate" };
  }

  const thresholdOffset = adapterProfile?.tuning?.thresholdOffset || 0;
  const min = Math.max(
    0.2,
    Math.min(0.95, thresholdForMode(settings.confidenceMode) + thresholdOffset),
  );

  if (task.hasDueDate) {
    return {
      keep: task.confidence >= min,
      reason: task.confidence >= min ? "kept" : "lowConfidence",
    };
  }

  if (!settings.includeUndatedCandidates) {
    return { keep: false, reason: "undatedDisabled" };
  }

  const undatedMin = Math.min(0.95, min + 0.15);
  return {
    keep: task.confidence >= undatedMin,
    reason: task.confidence >= undatedMin ? "kept" : "undatedLowConfidence",
  };
}

function isDueDateTooOld(dueDateIso, maxPastTaskYears) {
  if (!dueDateIso) return false;
  if (maxPastTaskYears === null || maxPastTaskYears === undefined) return false;

  const dueDate = new Date(dueDateIso);
  if (Number.isNaN(dueDate.getTime())) return false;

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - Number(maxPastTaskYears));
  return dueDate < cutoff;
}

function thresholdForMode(mode) {
  if (mode === "recall") return 0.4;
  if (mode === "precision") return 0.7;
  return 0.52;
}

function confidenceLabel(score) {
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

function dedupeTasks(tasks) {
  const byKey = new Map();

  for (const task of tasks) {
    const key = [
      normalizeText(task.title),
      task.dueDate ? task.dueDate.slice(0, 16) : "no-due",
    ].join("__");

    const existing = byKey.get(key);
    if (!existing || task.confidence > existing.confidence) {
      byKey.set(key, task);
    }
  }

  return Array.from(byKey.values());
}

function normalizeText(value) {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sortByDueDateThenConfidence(a, b) {
  if (a.dueDate && b.dueDate) {
    const diff = new Date(a.dueDate) - new Date(b.dueDate);
    if (diff !== 0) return diff;
  }

  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return b.confidence - a.confidence;
}

function fingerprintCandidate(el, text) {
  const idPart =
    (el.id ? `#${el.id}` : "") +
    (el.className && typeof el.className === "string"
      ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}`
      : "");
  return `${el.tagName}${idPart}:${text.slice(0, 160)}`;
}

function getCandidateText(el) {
  const parts = [];
  const own = el.innerText || el.textContent || "";
  if (own) parts.push(own);

  const attrs = [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("datetime"),
    el.getAttribute("data-due"),
    el.getAttribute("data-date"),
  ].filter(Boolean);

  if (attrs.length) parts.push(attrs.join("\n"));

  return parts
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanRawText(text) {
  const junkPatterns = [
    /^!+$/,
    /^skip to content$/i,
    /^courses$/i,
    /^groups$/i,
    /^resources$/i,
    /^more$/i,
    /^home$/i,
    /^grades$/i,
    /^start attempt$/i,
    /^english$/i,
    /^change language$/i,
    /^support$/i,
    /^privacy policy$/i,
    /^terms of use$/i,
    /^assignment$/i,
    /^my document$/i,
    /^\d+$/,
    /©\s*\d{4}/,
  ];

  const lines = (text || "").split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (isPostedOnLabel(trimmed)) return false;
    if (isPlaceholderLikeText(trimmed)) return false;
    for (const pattern of junkPatterns) {
      if (pattern.test(trimmed)) return false;
    }
    return true;
  });

  const deduped = cleaned.filter(
    (line, index) =>
      index === 0 ||
      line.trim().toLowerCase() !== cleaned[index - 1].trim().toLowerCase(),
  );

  return formatAsBreadcrumb(deduped);
}

function formatAsBreadcrumb(lines) {
  if (lines.length < 3) return lines.join("\n").trim();

  const hierarchy = [];
  const details = [];
  let foundAssignment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(trimmed)) continue;

    if (!foundAssignment && /section|period|class|block/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    if (!foundAssignment && /^unit\s+\d+/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    if (!foundAssignment && /^week\s+\d+/i.test(trimmed)) {
      hierarchy.push(trimmed);
      continue;
    }

    if (
      !foundAssignment &&
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(
        trimmed,
      )
    ) {
      hierarchy.push(trimmed);
      continue;
    }

    if (!foundAssignment && hierarchy.length > 0) {
      hierarchy.push(trimmed);
      foundAssignment = true;
      continue;
    }

    details.push(trimmed);
  }

  const output = [];
  if (hierarchy.length > 0) output.push(hierarchy.join(" > "));
  if (details.length > 0) {
    output.push("");
    output.push(...details);
  }

  return output.join("\n").trim();
}

function isVisible(el) {
  if (!el || !(el instanceof HTMLElement)) return false;

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

function parseDateTimeFromText(text) {
  if (!text) return null;
  const date = parseDate(text);
  if (!date) return null;

  const time = parseTime(text);
  if (time) {
    date.setHours(time.hours, time.minutes, 0, 0);
  }

  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseDate(text) {
  const native = new Date(text);
  if (!Number.isNaN(native.getTime()) && native.getFullYear() >= 2000) {
    return native;
  }

  const isoMatch = text.match(DATE_PATTERNS.iso);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const hour = parseInt(isoMatch[4] || "0", 10);
    const minute = parseInt(isoMatch[5] || "0", 10);
    return new Date(year, month, day, hour, minute);
  }

  const slashMatch = text.match(DATE_PATTERNS.slash);
  if (slashMatch) {
    const first = parseInt(slashMatch[1], 10);
    const second = parseInt(slashMatch[2], 10);
    let year = slashMatch[3]
      ? parseInt(slashMatch[3], 10)
      : new Date().getFullYear();

    if (year < 100) year += 2000;

    const monthFirst = first >= 1 && first <= 12;
    const dayFirst = second >= 1 && second <= 12;

    let month = first - 1;
    let day = second;

    if (!monthFirst && dayFirst) {
      // Interpret as DD/MM when first token cannot be month.
      month = second - 1;
      day = first;
    }

    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const dashMatch = text.match(DATE_PATTERNS.dashDMY);
  if (dashMatch) {
    const first = parseInt(dashMatch[1], 10);
    const second = parseInt(dashMatch[2], 10);
    let year = parseInt(dashMatch[3], 10);
    if (year < 100) year += 2000;

    // Prefer DD-MM-YYYY for dashed form used by many LMS locales.
    let day = first;
    let month = second - 1;

    if (first <= 12 && second > 12) {
      day = second;
      month = first - 1;
    }

    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const mdyMatch = text.match(DATE_PATTERNS.monthDayYear);
  if (mdyMatch) {
    const month = parseMonth(mdyMatch[1]);
    const day = parseInt(mdyMatch[2], 10);
    const year = parseInt(mdyMatch[3], 10);
    if (month !== -1) {
      return new Date(year, month, day);
    }
  }

  const mdMatch = text.match(DATE_PATTERNS.monthDay);
  if (mdMatch) {
    const month = parseMonth(mdMatch[1]);
    const day = parseInt(mdMatch[2], 10);
    if (month !== -1) {
      const now = new Date();
      const candidate = new Date(now.getFullYear(), month, day);
      if (candidate < now) candidate.setFullYear(now.getFullYear() + 1);
      return candidate;
    }
  }

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

function parseMonth(value) {
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
  const key = (value || "").toLowerCase().slice(0, 3);
  return months[key] ?? -1;
}

function parseTime(text) {
  const keywordMatch = text.match(
    /(?:at|until|by|before|after)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );

  if (keywordMatch) {
    return normalizeTime(
      parseInt(keywordMatch[1], 10),
      parseInt(keywordMatch[2] || "0", 10),
      keywordMatch[3]?.toLowerCase(),
    );
  }

  const times = [];
  let match;
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
  while ((match = pattern.exec(text)) !== null) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const meridian = match[3]?.toLowerCase();

    if (hours > 23) continue;
    if (!meridian && !match[2]) continue;

    times.push({ hours, minutes, meridian });
  }

  if (times.length === 0) return null;

  const withMeridian = times.find((entry) => entry.meridian);
  if (withMeridian) {
    return normalizeTime(
      withMeridian.hours,
      withMeridian.minutes,
      withMeridian.meridian,
    );
  }

  return normalizeTime(times[0].hours, times[0].minutes, times[0].meridian);
}

function normalizeTime(hours, minutes, meridian) {
  if (hours > 12) {
    return { hours: hours > 23 ? hours % 24 : hours, minutes };
  }

  if (meridian === "pm" && hours < 12) {
    hours += 12;
  } else if (meridian === "am" && hours === 12) {
    hours = 0;
  }

  return { hours, minutes };
}

function looksLikeDateOnly(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;

  if (DATE_PATTERNS.iso.test(trimmed)) return true;
  if (DATE_PATTERNS.monthDayYear.test(trimmed)) return true;
  if (DATE_PATTERNS.monthDay.test(trimmed)) return true;
  if (DATE_PATTERNS.slash.test(trimmed)) return true;
  if (DATE_PATTERNS.dashDMY.test(trimmed)) return true;

  return false;
}
