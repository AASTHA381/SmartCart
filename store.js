import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data", "users");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Anonymous per-user IDs are UUID-ish. Reject anything else so a crafted
// "userId" can't escape the data directory (path traversal).
export function sanitizeId(id) {
  const s = String(id || "").toLowerCase();
  return /^[a-z0-9-]{8,64}$/.test(s) ? s : null;
}

function defaultUser() {
  return {
    profile: { income: 0, fixed: [], currency: "₹" },
    goals: [],       // { id, name, target, saved }
    decisions: [],   // { id, ts, product, url, category, price, currency, verdict, confidence }
    watchlist: [],   // Phase 2
  };
}

function fileFor(id) {
  const safe = sanitizeId(id);
  return safe ? path.join(DATA_DIR, safe + ".json") : null;
}

export function getUser(id) {
  const file = fileFor(id);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...defaultUser(), ...data };
  } catch {
    return defaultUser();
  }
}

export function saveUser(id, data) {
  const file = fileFor(id);
  if (!file) return false;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return true;
}

// Aggregate dashboard stats from saved decisions.
export function computeStats(user) {
  const decisions = user.decisions || [];
  let avoided = 0, bought = 0, avoidedCount = 0, boughtCount = 0;
  const byCategory = {};
  for (const d of decisions) {
    const v = (d.verdict || "").toLowerCase();
    const cat = d.category || "Other";
    byCategory[cat] = byCategory[cat] || { count: 0, total: 0 };
    byCategory[cat].count++;
    byCategory[cat].total += d.price || 0;
    if (v.includes("buy") && !v.includes("don't") && !v.includes("dont")) {
      bought += d.price || 0; boughtCount++;
    } else {
      avoided += d.price || 0; avoidedCount++;
    }
  }
  return {
    totalDecisions: decisions.length,
    moneySaved: avoided,
    moneySavedCount: avoidedCount,
    moneySpent: bought,
    moneySpentCount: boughtCount,
    byCategory,
  };
}

// A short natural-language summary of spending patterns, fed to the model so
// its advice adapts to the user over time (personalization).
export function spendingPatterns(user) {
  const stats = computeStats(user);
  if (!stats.totalDecisions) return "No prior decisions yet.";
  const cats = Object.entries(stats.byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 4)
    .map(([c, v]) => `${c}: ${v.count} item(s), ${user.profile.currency}${Math.round(v.total)}`)
    .join("; ");
  return `Across ${stats.totalDecisions} past decisions — ${cats}.`;
}
