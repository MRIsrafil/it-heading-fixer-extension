/**
 * Heading Hierarchy Fixer — Webflow Designer Extension
 * ─────────────────────────────────────────────────────
 * Fixes two classes of heading issues on the current page:
 * 1. Multiple H1s  → all H1s after the first are demoted to H2
 * 2. Hierarchy skips → e.g. H2→H6 is corrected to H2→H3
 *
 * Webflow Designer API reference:
 * https://developers.webflow.com/designer/reference
 */

"use strict";

// ─── DOM Refs ───────────────────────────────────────────────────────────────
const btnFix       = document.getElementById("btnFix");
const btnScan      = document.getElementById("btnScan");
const btnClearLog  = document.getElementById("btnClearLog");
const statusStrip  = document.getElementById("statusStrip");
const statusText   = document.getElementById("statusText");
const logPanel     = document.getElementById("logPanel");
const logEmpty     = document.getElementById("logEmpty");
const statTotal    = document.getElementById("statTotal");
const statIssues   = document.getElementById("statIssues");
const statFixed    = document.getElementById("statFixed");
const statCardIssues = document.getElementById("statCardIssues");
const statCardFixed  = document.getElementById("statCardFixed");

// ─── Heading tag helpers ────────────────────────────────────────────────────
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/**
 * Returns the numeric level for a heading tag string, or null if not a heading.
 * @param {string} tag
 * @returns {number|null}
 */
function headingLevel(tag) {
  if (typeof tag !== "string") return null;
  const t = tag.toLowerCase().trim();
  const idx = HEADING_TAGS.indexOf(t);
  return idx === -1 ? null : idx + 1;
}

/**
 * Returns "h1" … "h6" for a given level number.
 * @param {number} level  1–6
 * @returns {string}
 */
function levelToTag(level) {
  return `h${Math.max(1, Math.min(6, level))}`;
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────
/** @param {"idle"|"info"|"success"|"warning"|"error"} type */
function setStatus(type, message) {
  statusStrip.className = `status-strip ${type}`;
  statusText.textContent = message;
}

/**
 * @param {string} message
 * @param {"fix"|"warn"|"error"|"info"|"muted"} [type="muted"]
 */
function log(message, type = "muted") {
  // Remove the "no activity" placeholder on first real entry
  if (logEmpty && logEmpty.parentNode === logPanel) {
    logPanel.removeChild(logEmpty);
  }

  const now  = new Date();
  const ts   = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;

  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${escapeHtml(message)}</span>`;
  logPanel.appendChild(entry);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStats(total, issues, fixed) {
  statTotal.textContent  = total  !== null ? total  : "—";
  statIssues.textContent = issues !== null ? issues : "—";
  statFixed.textContent  = fixed  !== null ? fixed  : "—";

  if (statCardIssues) statCardIssues.classList.toggle("warn",  issues > 0);
  if (statCardFixed) statCardFixed.classList.toggle("fixed",  fixed  > 0);
}

function setButtonsLoading(loading) {
  btnFix.disabled   = loading;
  btnScan.disabled  = loading;
  btnFix.classList.toggle("loading", loading);
}

// ─── Core: Recursive Element Tree Walker ────────────────────────────────────
/**
 * Recursively walk a Webflow element tree (breadth/depth).
 * Collects all elements where type === "Heading".
 *
 * @param {AnyElement} element
 * @param {AnyElement[]} collected  - array populated in-place
 * @returns {Promise<void>}
 */
async function collectHeadings(element, collected) {
  try {
    const type = await element.getType();
    if (type === "Heading") {
      collected.push(element);
    }
  } catch (_) {
    // Some element types may not support getType; skip them gracefully.
  }

  try {
    const children = await element.getChildren();
    if (Array.isArray(children) && children.length > 0) {
      for (const child of children) {
        await collectHeadings(child, collected);
      }
    }
  } catch (_) {
    // Leaf node or unsupported getChildren — no action needed.
  }
}

// ─── Core: Analyse Headings ──────────────────────────────────────────────────
/**
 * Given an ordered list of heading elements, returns an array of issue
 * descriptors without making any changes to the DOM.
 *
 * @param {Array<{element: AnyElement, tag: string}>} headingEntries
 * @returns {Array<object>}
 */
function analyseHeadings(headingEntries) {
  const issues = [];
  let h1Count = 0;
  let prevLevel = 0; // 0 = no heading seen yet

  for (let i = 0; i < headingEntries.length; i++) {
    const entry = headingEntries[i];
    const { element, tag } = entry;
    let currentLevel = headingLevel(tag);

    if (currentLevel === null) continue;

    let targetLevel = currentLevel;
    let isIssue = false;
    let reasonParts = [];

    // ── Rule 1: পেজের প্রথম হেডিং অবশ্যই H1 হতে হবে ──
    if (i === 0 && currentLevel !== 1) {
      targetLevel = 1;
      isIssue = true;
      reasonParts.push(`First heading must be H1 (found ${tag.toUpperCase()})`);
    }

    // ── Rule 2: একাধিক H1 থাকলে সেগুলোকে H2 করা ──
    if (currentLevel === 1) {
      h1Count++;
      if (h1Count > 1) {
        targetLevel = 2;
        isIssue = true;
        reasonParts.push(`Duplicate H1 found (H1 #${h1Count}) → demoted to H2`);
      }
    }

    // ── Rule 3: হেডিং সিকোয়েন্স স্কিপ চেক (যেমন H2 -> H6) ──
    // এটি শুধুমাত্র তখনই কাজ করবে যখন আগের কোনো হেডিং লেভেল থাকবে এবং এটি ব্যাকওয়ার্ড জাম্প হবে না
    const effectivePrevLevel = i === 0 ? prevLevel : (headingEntries[i - 1].effectiveLevel ?? prevLevel);
    
    if (effectivePrevLevel > 0) {
      // যদি কারেন্ট লেভেল আগের ইফেক্টিভ লেভেলের চেয়ে ১ এর বেশি বড় হয়
      const checkLevel = isIssue ? targetLevel : currentLevel;
      if (checkLevel - effectivePrevLevel > 1) {
        targetLevel = effectivePrevLevel + 1;
        isIssue = true;
        reasonParts.push(`Hierarchy skip detected (${levelToTag(effectivePrevLevel).toUpperCase()} → ${tag.toUpperCase()}, corrected to ${levelToTag(targetLevel).toUpperCase()})`);
      }
    }

    // ইফেক্টিভ লেভেল ট্র্যাক করে রাখা যাতে পরবর্তী লুপ এটি ব্যবহার করতে পারে
    entry.effectiveLevel = isIssue ? targetLevel : currentLevel;
    prevLevel = entry.effectiveLevel;

    if (isIssue) {
      issues.push({
        element,
        currentTag: tag,
        currentLevel,
        targetTag: levelToTag(targetLevel),
        targetLevel,
        reason: reasonParts.join(" + "),
      });
    }
  }

  return issues;
}

// ─── Core: Apply Fixes ──────────────────────────────────────────────────────
/**
 * Applies a list of issue fixes by calling element.setTag(targetTag).
 * Returns the count of successfully applied fixes.
 *
 * @param {Array<object>} issues
 * @returns {Promise<number>}
 */
async function applyFixes(issues) {
  let fixedCount = 0;

  for (const issue of issues) {
    try {
      await issue.element.setTag(issue.targetTag);
      log(`✓ Fixed: ${issue.reason}`, "fix");
      fixedCount++;
    } catch (err) {
      log(`✗ Failed to fix ${issue.currentTag}: ${err.message ?? err}`, "error");
    }
  }

  return fixedCount;
}

// ─── Core: Main Orchestrator ─────────────────────────────────────────────────
/**
 * Main entry point shared by Scan and Fix modes.
 *
 * @param {"scan"|"fix"} mode
 */
async function run(mode) {
  setButtonsLoading(true);
  setStatus("info", mode === "fix" ? "Scanning page for heading issues…" : "Scanning page…");
  log(`─── ${mode === "fix" ? "Fix" : "Scan"} started ───────────────────────`, "info");

  try {
    // ── 1. Get the page root ──────────────────────────────────────────
    const rootElement = await webflow.getRootElement();
    if (!rootElement) {
      setStatus("error", "Could not access page root. Is a page open?");
      log("Error: getRootElement() returned null. Open a page first.", "error");
      setStats(null, null, null);
      return;
    }

    log("Page root acquired. Traversing element tree…", "muted");

    // ── 2. Collect all heading elements ──────────────────────────────
    const rawHeadings = [];
    await collectHeadings(rootElement, rawHeadings);

    log(`Found ${rawHeadings.length} heading element${rawHeadings.length !== 1 ? "s" : ""}.`, "muted");

    if (rawHeadings.length === 0) {
      setStatus("success", "No headings on this page — nothing to check.");
      setStats(0, 0, 0);
      log("Nothing to fix.", "muted");
      return;
    }

    // ── 3. Read current tags ──────────────────────────────────────────
    const headingEntries = [];
    for (const el of rawHeadings) {
      try {
        const tag = await el.getTag();
        const level = headingLevel(tag);
        if (level !== null) {
          headingEntries.push({ element: el, tag });
        }
      } catch (err) {
        log(`Warning: Could not read tag for an element — skipped. (${err.message ?? err})`, "warn");
      }
    }

    // ── 4. Analyse ────────────────────────────────────────────────────
    const issues = analyseHeadings(headingEntries);

    log(`Analysis complete. ${issues.length} issue${issues.length !== 1 ? "s" : ""} found.`, issues.length > 0 ? "warn" : "muted");

    setStats(headingEntries.length, issues.length, null);

    if (issues.length === 0) {
      setStatus("success", "No heading issues detected — structure is clean!");
      setStats(headingEntries.length, 0, 0);
      return;
    }

    // ── 5a. Scan only — report issues, no writes ──────────────────────
    if (mode === "scan") {
      log("Issues detected (scan mode — no changes made):", "warn");
      issues.forEach(issue => {
        log(`  • ${issue.reason}`, "warn");
      });
      setStatus("warning", `${issues.length} issue${issues.length !== 1 ? "s" : ""} found. Click "Fix Heading Issues" to apply corrections.`);
      setStats(headingEntries.length, issues.length, null);
      return;
    }

    // ── 5b. Fix mode — apply corrections ─────────────────────────────
    log(`Applying ${issues.length} fix${issues.length !== 1 ? "es" : ""}…`, "info");
    const fixedCount = await applyFixes(issues);

    setStats(headingEntries.length, issues.length, fixedCount);

    if (fixedCount === issues.length) {
      setStatus("success", `All ${fixedCount} issue${fixedCount !== 1 ? "s" : ""} fixed successfully!`);
      log(`─── Done. ${fixedCount} fix${fixedCount !== 1 ? "es" : ""} applied. ───────────────────────`, "fix");
    } else {
      const failed = issues.length - fixedCount;
      setStatus("warning", `${fixedCount} fixed, ${failed} failed. Check the log for details.`);
      log(`─── Done with errors. ${fixedCount} fixed, ${failed} failed. ───`, "warn");
    }

  } catch (err) {
    const message = err?.message ?? String(err);
    setStatus("error", `Unexpected error: ${message}`);
    log(`Unexpected error: ${message}`, "error");
    console.error("[Heading Fixer] Unexpected error:", err);
    setStats(null, null, null);
  } finally {
    setButtonsLoading(false);
  }
}

// ─── Button Handlers ────────────────────────────────────────────────────────
if (btnFix) btnFix.addEventListener("click", () => run("fix"));
if (btnScan) btnScan.addEventListener("click", () => run("scan"));

if (btnClearLog) {
  btnClearLog.addEventListener("click", () => {
    logPanel.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.id        = "logEmpty";
    empty.textContent = "No activity yet.";
    logPanel.appendChild(empty);
    setStats(null, null, null);
    if (statCardIssues) statCardIssues.classList.remove("warn");
    if (statCardFixed) statCardFixed.classList.remove("fixed");
    setStatus("idle", "Ready — click a button below to begin.");
  });
}

// ─── Webflow Extension Lifecycle ────────────────────────────────────────────
try {
  webflow.setExtensionSize({ height: 600 });
} catch (_) {
  // setExtensionSize is optional / may not exist in all runtime versions
}