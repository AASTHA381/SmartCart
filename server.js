import express from "express";
import * as cheerio from "cheerio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getUser, saveUser, computeStats, spendingPatterns } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const PORT = process.env.PORT || 8787;

const CURRENCY_SYMBOLS = {
  INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", AED: "د.إ",
};

// ---------------------------------------------------------------------------
// Price detection: fetch the product page and best-effort extract price/title.
// Retail sites vary wildly (and some block bots), so this is best-effort — the
// frontend always lets the user correct the price manually.
// ---------------------------------------------------------------------------
function toNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fromJsonLd($) {
  let result = { price: null, currency: null, title: null };
  $('script[type="application/ld+json"]').each((_, node) => {
    if (result.price) return;
    let raw = $(node).contents().text();
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
      const type = item["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (isProduct || item.offers) {
        if (!result.title && item.name) result.title = item.name;
        let offers = item.offers;
        if (Array.isArray(offers)) offers = offers[0];
        if (offers && typeof offers === "object") {
          const p = toNumber(offers.price ?? offers.lowPrice ?? offers.priceSpecification?.price);
          if (p) result.price = p;
          if (offers.priceCurrency) result.currency = offers.priceCurrency;
        }
      }
    }
  });
  return result;
}

function fromMeta($) {
  const metaContent = (sel) => $(sel).attr("content") || null;
  const price =
    toNumber(metaContent('meta[property="product:price:amount"]')) ||
    toNumber(metaContent('meta[property="og:price:amount"]')) ||
    toNumber(metaContent('meta[itemprop="price"]')) ||
    toNumber($('[itemprop="price"]').attr("content")) ||
    toNumber($('[itemprop="price"]').first().text());
  const currency =
    metaContent('meta[property="product:price:currency"]') ||
    metaContent('meta[property="og:price:currency"]') ||
    metaContent('meta[itemprop="priceCurrency"]') ||
    $('[itemprop="priceCurrency"]').attr("content") ||
    null;
  const title = metaContent('meta[property="og:title"]') || $("title").first().text().trim() || null;
  const image = metaContent('meta[property="og:image"]') || null;
  return { price, currency, title, image };
}

function fromCommonSelectors($) {
  // Common price containers used across many storefronts.
  const selectors = [
    "#priceblock_ourprice", "#priceblock_dealprice", "#corePrice_feature_div .a-offscreen",
    ".a-price .a-offscreen", ".a-price-whole",     // Amazon
    "._30jeq3._16Jk6d", "._30jeq3", "._16Jk6d",    // Flipkart
    ".pdp-price strong", ".pdp-price",             // Myntra
    ".prod-sp",                                     // Ajio
    ".price_color",                                 // books.toscrape
    '[itemprop="price"]',
    ".product-price", ".price--main", ".price-item--sale", ".product__price",
    ".price", '[class*="price" i]',
  ];
  for (const sel of selectors) {
    let found = null;
    $(sel).each((_, node) => {
      if (found) return;
      const txt = ($(node).attr("content") || $(node).text() || "").trim();
      if (!txt) return;
      const m = txt.match(/(₹|Rs\.?|INR|\$|USD|£|€)\s?([0-9][0-9.,]*)/i);
      if (m) { found = parsePriceMatch(m); return; }
      // Plain-number fallback for these known price containers (e.g. Amazon's
      // ".a-price-whole" is just "29,990").
      const n = txt.replace(/[^0-9.]/g, "");
      if (n.replace(/\./g, "").length >= 2) { const p = toNumber(n); if (p) found = { price: p, currency: null }; }
    });
    if (found && found.price) return found;
  }
  return { price: null, currency: null };
}

// Many SPA storefronts (Flipkart, Myntra, Ajio, Amazon, Shopify) embed the
// price in a JSON blob in the initial HTML even when it isn't in visible markup.
function fromEmbeddedJson(html) {
  const keys = ["sellingPrice", "finalPrice", "discountedPrice", "specialPrice", "salePrice", "offerPrice", "currentPrice", "priceValue", "price_amount", "price", "mrp", "amount"];
  for (const key of keys) {
    // "key":12345  |  "key":"12345"  |  "key":{"value":12345}  |  "key":{"amount":12345}
    const re = new RegExp('"' + key + '"\\s*:\\s*(?:\\{[^{}]*?"(?:value|amount|price)"\\s*:\\s*)?"?([0-9]{2,}(?:\\.[0-9]{1,2})?)"?', "i");
    const m = html.match(re);
    if (m) { const p = toNumber(m[1]); if (p) return { price: p, currency: null }; }
  }
  return { price: null, currency: null };
}

function parsePriceMatch(m) {
  const symbol = m[1];
  const currency = symbol.includes("₹") || /rs|inr/i.test(symbol) ? "INR"
    : symbol === "$" || /usd/i.test(symbol) ? "USD"
    : symbol === "£" ? "GBP" : symbol === "€" ? "EUR" : null;
  return { price: toNumber(m[2]), currency };
}

function fromRegex(html) {
  // Last resort: find a currency-tagged number anywhere in the raw HTML.
  const m = html.match(/(₹|Rs\.?|INR|\$|USD|£|€)\s?([0-9][0-9.,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return { price: null, currency: null };
  return parsePriceMatch(m);
}

// Reusable: fetch a product page and best-effort extract price/title/image.
async function detectProductPrice(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    const ld = fromJsonLd($);
    const meta = fromMeta($);
    const sel = fromCommonSelectors($);
    const emb = fromEmbeddedJson(html);
    const rx = fromRegex(html);

    const price = ld.price || meta.price || sel.price || emb.price || rx.price || null;
    let currencyCode = ld.currency || meta.currency || sel.currency || rx.currency || null;
    if (price && !currencyCode) {
      if (/(₹|\bINR\b|Rs\.?)/.test(html)) currencyCode = "INR";
      else if (/[£]|\bGBP\b/.test(html)) currencyCode = "GBP";
      else if (/[€]|\bEUR\b/.test(html)) currencyCode = "EUR";
      else if (/\$|\bUSD\b/.test(html)) currencyCode = "USD";
    }
    const title = (ld.title || meta.title || "").replace(/\s+/g, " ").trim() || null;
    return {
      price,
      currency: currencyCode,
      currencySymbol: currencyCode ? CURRENCY_SYMBOLS[currencyCode] || null : null,
      title,
      image: meta.image || null,
      detected: !!price,
      status: resp.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/price", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Please provide a valid product URL." });
  }
  try {
    res.json(await detectProductPrice(url));
  } catch (err) {
    res.json({ price: null, title: null, detected: false, note: "Couldn't read that page automatically." });
  }
});

// ---------------------------------------------------------------------------
// Decision: send the budget context to the model and return structured reasoning.
// ---------------------------------------------------------------------------
const CATEGORIES = ["Electronics", "Fashion", "Essentials", "Food", "Health", "Home", "Entertainment", "Travel", "Education", "Other"];

const SYSTEM_PROMPT = `You are a pragmatic personal-finance decision assistant.
Given a potential purchase and the person's full money context (income, fixed expenses, discretionary budget, savings goals, and past spending patterns), give an honest, reasoned recommendation.
Weigh: need vs want, budget impact, opportunity cost, timing, durability/value, impact on their savings goals, and cheaper alternatives.
Use their spending patterns to personalise: if they repeatedly overspend in a category, be stricter there.
Be direct and specific to THEIR numbers. Do not moralize or lecture. It's okay to say "Buy" for a justified want.
Pick a category from exactly this list: ${CATEGORIES.join(", ")}.
Respond with ONLY valid JSON (no markdown, no prose) using exactly this schema:
{
  "verdict": "Buy" | "Wait" | "Don't buy",
  "confidence": <integer 0-100>,
  "category": "<one of the categories above>",
  "headline": "<one short sentence>",
  "budget_impact": "<one sentence referencing their actual numbers>",
  "goal_impact": "<one sentence on how this affects their savings goals, or empty string if no goals>",
  "cost_per_use": "<short reframe like 'about ₹27/day if used daily for 3 years', or empty>",
  "reasons_for": ["<short>", "..."],
  "reasons_against": ["<short>", "..."],
  "alternatives": ["<short>", "..."],
  "reasoning": "<2-4 sentence reasoned explanation>"
}`;

function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

app.post("/api/decide", async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY. Copy .env.example to .env and add your free Groq key." });
  }
  const input = req.body || {};
  if (!input.product || !input.price) {
    return res.status(400).json({ error: "Product and price are required." });
  }

  // Pull the user's stored context (profile, goals, spending patterns).
  const userId = req.get("x-user-id");
  const user = getUser(userId);
  const profile = user?.profile || { income: 0, fixed: [], currency: input.currency || "₹" };
  const fixedTotal = (profile.fixed || []).reduce((a, f) => a + (Number(f.amount) || 0), 0);
  const discretionaryBudget = Math.max(0, (Number(profile.income) || 0) - fixedTotal);

  const payload = {
    currency: input.currency || profile.currency || "₹",
    product: input.product,
    product_url: input.product_url || null,
    price: input.price,
    monthly_income: Number(profile.income) || null,
    fixed_expenses_total: fixedTotal || null,
    discretionary_budget: discretionaryBudget || null,
    discretionary_spent_this_month: input.spent_this_month || 0,
    discretionary_remaining: discretionaryBudget ? Math.max(0, discretionaryBudget - (input.spent_this_month || 0)) : null,
    recent_expenses: input.recent_expenses || [],
    savings_goals: (user?.goals || []).map(g => ({ name: g.name, target: g.target, saved: g.saved })),
    spending_patterns: user ? spendingPatterns(user) : "No history.",
  };

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.5,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload, null, 2) },
        ],
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return res.status(502).json({ error: body?.error?.message || `Groq API error ${r.status}` });
    }
    const data = await r.json();
    const out = extractJson(data?.choices?.[0]?.message?.content || "");

    // Persist the decision for history / dashboard / personalization.
    if (user) {
      const record = {
        id: "d_" + Date.now().toString(36),
        ts: Date.now(),
        product: input.product,
        url: input.product_url || null,
        category: out.category || "Other",
        price: Number(input.price) || 0,
        currency: payload.currency,
        verdict: out.verdict || "",
        confidence: Number(out.confidence) || 0,
      };
      user.decisions = user.decisions || [];
      user.decisions.unshift(record);
      if (user.decisions.length > 200) user.decisions.length = 200;
      saveUser(userId, user);
      out._decisionId = record.id;
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "Couldn't reach the reasoning service: " + err.message });
  }
});

// ---------------------------------------------------------------------------
// Per-user data: profile (income + fixed expenses), savings goals, history.
// No login — data is keyed by an anonymous ID the browser generates and keeps.
// ---------------------------------------------------------------------------
function requireUser(req, res) {
  const user = getUser(req.get("x-user-id"));
  if (!user) { res.status(400).json({ error: "Missing or invalid user id." }); return null; }
  return user;
}

app.get("/api/profile", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ profile: user.profile, goals: user.goals, stats: computeStats(user) });
});

app.post("/api/profile", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { income, fixed, currency } = req.body || {};
  user.profile = {
    income: Number(income) || 0,
    fixed: Array.isArray(fixed) ? fixed.map(f => ({ label: String(f.label || "Expense"), amount: Number(f.amount) || 0 })) : [],
    currency: currency || user.profile.currency || "₹",
  };
  saveUser(req.get("x-user-id"), user);
  res.json({ ok: true, profile: user.profile });
});

app.post("/api/goals", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { name, target, saved } = req.body || {};
  if (!name || !target) return res.status(400).json({ error: "Goal name and target are required." });
  user.goals = user.goals || [];
  user.goals.push({ id: "g_" + Date.now().toString(36), name: String(name), target: Number(target) || 0, saved: Number(saved) || 0 });
  saveUser(req.get("x-user-id"), user);
  res.json({ ok: true, goals: user.goals });
});

app.delete("/api/goals/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.goals = (user.goals || []).filter(g => g.id !== req.params.id);
  saveUser(req.get("x-user-id"), user);
  res.json({ ok: true, goals: user.goals });
});

app.get("/api/history", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ decisions: user.decisions || [], stats: computeStats(user) });
});

// ---------------------------------------------------------------------------
// Watchlist: save items to reconsider, with a 30-day cool-off reminder and
// on-demand price re-checks so drops/sales surface in the app.
// ---------------------------------------------------------------------------
function decorateWatchItem(w, now) {
  const drop = Math.round(((w.startPrice || 0) - (w.lastPrice || 0)) * 100) / 100;
  return {
    ...w,
    drop,
    dropPct: w.startPrice ? Math.round((drop / w.startPrice) * 100) : 0,
    reminderDue: !!(w.remindAt && w.remindAt <= now),
    trackable: !!w.url,
  };
}

app.post("/api/watchlist", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { product, url, price, currency, category, verdict, remindDays } = req.body || {};
  if (!product || !price) return res.status(400).json({ error: "Product and price are required." });
  const now = Date.now();
  const p = Number(price) || 0;
  user.watchlist = user.watchlist || [];
  // Avoid duplicates (same product + url).
  user.watchlist = user.watchlist.filter(w => !(w.product === product && (w.url || "") === (url || "")));
  const item = {
    id: "w_" + now.toString(36),
    product: String(product),
    url: url || null,
    category: category || "Other",
    currency: currency || "₹",
    verdict: verdict || null,
    startPrice: p,
    lastPrice: p,
    lowestPrice: p,
    addedTs: now,
    lastCheckedTs: now,
    remindAt: remindDays ? now + Number(remindDays) * 86400000 : null,
    history: [{ ts: now, price: p }],
  };
  user.watchlist.unshift(item);
  if (user.watchlist.length > 100) user.watchlist.length = 100;
  saveUser(req.get("x-user-id"), user);
  res.json({ ok: true, item: decorateWatchItem(item, now) });
});

app.delete("/api/watchlist/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  user.watchlist = (user.watchlist || []).filter(w => w.id !== req.params.id);
  saveUser(req.get("x-user-id"), user);
  res.json({ ok: true });
});

app.get("/api/watchlist", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = Date.now();
  res.json({ watchlist: (user.watchlist || []).map(w => decorateWatchItem(w, now)) });
});

// Re-check prices for trackable items (throttled) — called when the user opens
// the Saved tab. Surfaces drops without needing an always-on cron.
app.post("/api/watchlist/refresh", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = Date.now();
  const items = user.watchlist || [];
  const force = !!(req.body && req.body.force);
  const stale = items.filter(w => w.url && (force || now - (w.lastCheckedTs || 0) > 2 * 3600 * 1000)).slice(0, 6);
  await Promise.all(stale.map(async (w) => {
    try {
      const r = await detectProductPrice(w.url);
      w.lastCheckedTs = now;
      if (r && r.price) {
        if (r.price !== w.lastPrice) {
          w.history = [...(w.history || []), { ts: now, price: r.price }].slice(-40);
        }
        w.lastPrice = r.price;
        if (r.price < (w.lowestPrice || r.price + 1)) w.lowestPrice = r.price;
      }
    } catch { /* leave item as-is on failure */ }
  }));
  saveUser(req.get("x-user-id"), user);
  res.json({ watchlist: items.map(w => decorateWatchItem(w, now)), checked: stale.length });
});

app.listen(PORT, () => {
  console.log(`\n  Should I Buy This? → http://localhost:${PORT}\n`);
  if (!process.env.GROQ_API_KEY) {
    console.log("  ⚠  No GROQ_API_KEY set. Copy .env.example to .env and add your free key from https://console.groq.com/keys\n");
  }
});
