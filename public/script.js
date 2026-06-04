"use strict";

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const btnFix        = document.getElementById("btnFix");
const btnScan       = document.getElementById("btnScan");
const btnClearLog   = document.getElementById("btnClearLog");
const statusStrip   = document.getElementById("statusStrip");
const statusText    = document.getElementById("statusText");
const logPanel      = document.getElementById("logPanel");
const logEmpty      = document.getElementById("logEmpty");
const statTotal     = document.getElementById("statTotal");
const statIssues    = document.getElementById("statIssues");
const statFixed     = document.getElementById("statFixed");
const statCardIssues = document.getElementById("statCardIssues");
const statCardFixed  = document.getElementById("statCardFixed");

// ─── Heading helpers ─────────────────────────────────────────────────────────
const HEADING_TAGS = ["h1","h2","h3","h4","h5","h6"];

function headingLevel(tag) {
  if (typeof tag !== "string") return null;
  const idx = HEADING_TAGS.indexOf(tag.toLowerCase().trim());
  return idx === -1 ? null : idx + 1;
}

function levelToTag(level) {
  return "h" + Math.max(1, Math.min(6, level));
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function setStatus(type, message) {
  statusStrip.className = "status-strip " + type;
  statusText.textContent = message;
}

function log(message, type) {
  type = type || "muted";
  if (logEmpty && logEmpty.parentNode === logPanel) {
    logPanel.removeChild(logEmpty);
  }
  const now = new Date();
  const ts  = String(now.getHours()).padStart(2,"0") + ":" +
              String(now.getMinutes()).padStart(2,"0") + ":" +
              String(now.getSeconds()).padStart(2,"0");
  const entry = document.createElement("div");
  entry.className = "log-entry " + type;
  entry.innerHTML = '<span class="log-ts">' + ts + '</span>' +
                    '<span class="log-msg">' + escapeHtml(message) + '</span>';
  logPanel.appendChild(entry);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function setStats(total, issues, fixed) {
  statTotal.textContent  = total  !== null ? total  : "—";
  statIssues.textContent = issues !== null ? issues : "—";
  statFixed.textContent  = fixed  !== null ? fixed  : "—";
  statCardIssues.classList.toggle("warn",  issues > 0);
  statCardFixed.classList.toggle("fixed",  fixed  > 0);
}

function setButtonsLoading(loading) {
  btnFix.disabled  = loading;
  btnScan.disabled = loading;
  btnFix.classList.toggle("loading", loading);
}

// ─── Check Webflow API ───────────────────────────────────────────────────────
function isWebflowAvailable() {
  return typeof webflow !== "undefined" && webflow !== null;
}

// ─── Recursive heading collector ─────────────────────────────────────────────
async function collectHeadings(element, collected) {
  try {
    const type = await element.getType();
    if (type === "Heading") {
      collected.push(element);
    }
  } catch (_) {}

  try {
    const children = await element.getChildren();
    if (Array.isArray(children) && children.length > 0) {
      for (const child of children) {
        await collectHeadings(child, collected);
      }
    }
  } catch (_) {}
}

// ─── Analyse headings ─────────────────────────────────────────────────────────
function analyseHeadings(headingEntries) {
  const issues = [];
  let h1Count   = 0;
  let prevLevel = 0;

  for (const entry of headingEntries) {
    const { element, tag } = entry;
    let currentLevel = headingLevel(tag);
    if (currentLevel === null) continue;

    // Rule 1: Multiple H1
    if (currentLevel === 1) {
      h1Count++;
      if (h1Count > 1) {
        const target = 2;
        issues.push({
          element,
          currentTag:   tag,
          currentLevel,
          targetTag:    levelToTag(target),
          targetLevel:  target,
          reason:       "Duplicate H1 #" + h1Count + " → demoted to H2",
        });
        currentLevel = target;
        entry.effectiveLevel = target;
      } else {
        entry.effectiveLevel = 1;
      }
    } else {
      entry.effectiveLevel = currentLevel;
    }

    // Rule 2: Hierarchy skip
    if (prevLevel > 0 && currentLevel > prevLevel + 1) {
      const target = prevLevel + 1;
      const existing = issues.find(function(i) { return i.element === element; });
      if (existing) {
        existing.targetTag   = levelToTag(target);
        existing.targetLevel = target;
        existing.reason     += " + skip " + levelToTag(prevLevel) + "→" + levelToTag(currentLevel) + " fixed to " + levelToTag(target);
      } else {
        issues.push({
          element,
          currentTag:   levelToTag(currentLevel),
          currentLevel,
          targetTag:    levelToTag(target),
          targetLevel:  target,
          reason:       "Skip: " + levelToTag(prevLevel) + " → " + levelToTag(currentLevel) + " corrected to " + levelToTag(target),
        });
      }
      entry.effectiveLevel = target;
      currentLevel = target;
    }

    prevLevel = entry.effectiveLevel !== undefined ? entry.effectiveLevel : currentLevel;
  }

  return issues;
}

// ─── Apply fixes ─────────────────────────────────────────────────────────────
async function applyFixes(issues) {
  let fixedCount = 0;
  for (const issue of issues) {
    try {
      await issue.element.setTag(issue.targetTag);
      log("✓ " + issue.reason, "fix");
      fixedCount++;
    } catch (err) {
      log("✗ Failed: " + (err.message || err), "error");
    }
  }
  return fixedCount;
}

// ─── Main runner ─────────────────────────────────────────────────────────────
async function run(mode) {

  // ── Guard: check Webflow API is available ──────────────────────────────────
  if (!isWebflowAvailable()) {
    setStatus("error", "Webflow Designer API not found.");
    log("Error: This extension must run inside the Webflow Designer.", "error");
    log("Open this via the Apps panel in Webflow Designer (press E).", "warn");
    return;
  }

  setButtonsLoading(true);
  setStatus("info", mode === "fix" ? "Scanning for heading issues…" : "Scanning page…");
  log("─── " + (mode === "fix" ? "Fix" : "Scan") + " started ───────────────────────", "info");

  try {
    // 1. Get root
    const rootElement = await webflow.getRootElement();
    if (!rootElement) {
      setStatus("error", "Cannot access page root. Is a page open?");
      log("Error: getRootElement() returned null.", "error");
      setStats(null, null, null);
      return;
    }

    log("Page root found. Scanning elements…", "muted");

    // 2. Collect headings
    const rawHeadings = [];
    await collectHeadings(rootElement, rawHeadings);
    log("Found " + rawHeadings.length + " heading element(s).", "muted");

    if (rawHeadings.length === 0) {
      setStatus("success", "No headings on this page — nothing to check.");
      setStats(0, 0, 0);
      log("No headings found.", "muted");
      return;
    }

    // 3. Read tags
    const headingEntries = [];
    for (const el of rawHeadings) {
      try {
        const tag   = await el.getTag();
        const level = headingLevel(tag);
        if (level !== null) {
          headingEntries.push({ element: el, tag: tag });
        }
      } catch (err) {
        log("Warning: Could not read tag — skipped.", "warn");
      }
    }

    // 4. Analyse
    const issues = analyseHeadings(headingEntries);
    log("Analysis done. " + issues.length + " issue(s) found.", issues.length > 0 ? "warn" : "muted");
    setStats(headingEntries.length, issues.length, null);

    if (issues.length === 0) {
      setStatus("success", "No heading issues — structure is clean!");
      setStats(headingEntries.length, 0, 0);
      return;
    }

    // 5a. Scan only
    if (mode === "scan") {
      log("Issues found (scan only — no changes made):", "warn");
      issues.forEach(function(issue) {
        log("  • " + issue.reason, "warn");
      });
      setStatus("warning", issues.length + " issue(s) found. Click Fix to apply corrections.");
      return;
    }

    // 5b. Fix mode
    log("Applying " + issues.length + " fix(es)…", "info");
    const fixedCount = await applyFixes(issues);
    setStats(headingEntries.length, issues.length, fixedCount);

    if (fixedCount === issues.length) {
      setStatus("success", "All " + fixedCount + " issue(s) fixed successfully!");
      log("─── Done. " + fixedCount + " fix(es) applied. ───────────────────────", "fix");
    } else {
      const failed = issues.length - fixedCount;
      setStatus("warning", fixedCount + " fixed, " + failed + " failed. Check log.");
      log("─── Done with errors. " + fixedCount + " fixed, " + failed + " failed. ───", "warn");
    }

  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    setStatus("error", "Error: " + message);
    log("Error: " + message, "error");
    setStats(null, null, null);
  } finally {
    setButtonsLoading(false);
  }
}

// ─── Button events ────────────────────────────────────────────────────────────
btnFix.addEventListener("click",  function() { run("fix");  });
btnScan.addEventListener("click", function() { run("scan"); });

btnClearLog.addEventListener("click", function() {
  logPanel.innerHTML = "";
  const empty = document.createElement("div");
  empty.className   = "log-empty";
  empty.id          = "logEmpty";
  empty.textContent = "No activity yet.";
  logPanel.appendChild(empty);
  setStats(null, null, null);
  statCardIssues.classList.remove("warn");
  statCardFixed.classList.remove("fixed");
  setStatus("idle", "Ready — click a button below to begin.");
});

// ─── Extension size ───────────────────────────────────────────────────────────
try {
  webflow.setExtensionSize({ height: 600 });
} catch (_) {}