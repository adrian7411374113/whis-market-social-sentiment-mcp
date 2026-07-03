#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchCombinedSocialSentiment } from "../server.mjs";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MISSION_MARKET_DIR = process.env.MISSION_CONTROL_MARKET_DIR || "/root/projects/mission-control/assets/data/market";
const SNAPSHOT_DIR = process.env.MARKET_SOCIAL_SENTIMENT_SNAPSHOT_DIR || join(PROJECT_ROOT, "snapshots");
const DEFAULT_SOURCE_FILES = [
  "council-reviewed-candidates.json",
  "ticker-signal-stack.json",
  "pro-investor-watchlist.json",
  "elite-watchlist.json",
  "conviction-timing-matrix.json"
];
const DEFAULT_SUBREDDITS = ["stocks", "investing", "wallstreetbets", "SecurityAnalysis"];
const SYMBOL_KEYS = new Set(["symbol", "ticker", "asset", "primaryticker", "canonicalticker"]);
const FALSE_POSITIVES = new Set([
  "API", "CEO", "CFO", "CTO", "ETF", "EPS", "GDP", "IPO", "MCP", "MOM", "NAV", "RSS", "SEC", "USD"
]);
const SOURCE_BASE_WEIGHTS = new Map([
  ["council-reviewed-candidates.json", 10],
  ["ticker-signal-stack.json", 4],
  ["pro-investor-watchlist.json", 3],
  ["elite-watchlist.json", 3],
  ["conviction-timing-matrix.json", 2]
]);

function getArg(name, fallback = null) {
  const prefix = "--" + name + "=";
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function getFlag(name) {
  return process.argv.includes("--" + name);
}

function toInt(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-_]{0,7}$/.test(symbol)) return null;
  if (FALSE_POSITIVES.has(symbol)) return null;
  return symbol;
}

function addSymbol(scores, raw, source, weight = 1) {
  const symbol = normalizeSymbol(raw);
  if (!symbol) return;
  const item = scores.get(symbol) || { symbol, score: 0, sources: new Set() };
  item.score += weight;
  item.sources.add(source);
  scores.set(symbol, item);
}

function socialPriorityForRecord(record, fileName) {
  let weight = SOURCE_BASE_WEIGHTS.get(fileName) || 1;
  const verdict = String(record?.councilVerdict || "").toLowerCase();
  const priority = String(record?.researchPriority || "").toLowerCase();
  const intake = Array.isArray(record?.intakeBuckets) ? record.intakeBuckets.map(String) : [];
  const rank = Number(record?.finalRank);
  const score = Number(record?.finalScore ?? record?.researchPriorityScore ?? record?.score);

  if (Number.isFinite(rank) && rank > 0) weight += Math.max(0, 42 - rank);
  if (record?.topResearchCandidate) weight += 30;
  if (priority === "research-now") weight += 28;
  else if (priority === "high-watch") weight += 20;
  else if (priority === "speculative-research") weight += 12;
  if (verdict === "promote") weight += 28;
  else if (verdict === "watch") weight += 16;
  else if (verdict === "demote") weight += 4;
  if (intake.includes("watchlist-review")) weight += 18;
  if (Number.isFinite(score)) weight += Math.max(0, Math.min(20, Math.round((score - 60) / 2)));
  return weight;
}

function walkForSymbols(value, scores, source, key = "", weight = 1) {
  if (value == null) return;
  if (typeof value === "string") {
    if (SYMBOL_KEYS.has(key.toLowerCase())) addSymbol(scores, value, source, weight);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 600)) walkForSymbols(item, scores, source, key, weight);
    return;
  }
  if (typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value).slice(0, 800)) {
    if (SYMBOL_KEYS.has(childKey.toLowerCase()) && typeof childValue === "string") {
      addSymbol(scores, childValue, source, weight);
    } else {
      walkForSymbols(childValue, scores, source, childKey, weight);
    }
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function discoverSymbols(sourceFiles) {
  const scores = new Map();
  const explicit = getArg("symbols", process.env.MARKET_SOCIAL_PREFETCH_SYMBOLS || "");
  const explicitSymbols = explicit.split(/[\s,]+/).filter(Boolean);
  if (explicitSymbols.length) {
    for (const item of explicitSymbols) addSymbol(scores, item, "explicit", 20);
    return [...scores.values()]
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
      .map((item) => ({ symbol: item.symbol, score: item.score, sources: [...item.sources].sort() }));
  }

  for (const fileName of sourceFiles) {
    const file = fileName.startsWith("/") ? fileName : join(MISSION_MARKET_DIR, fileName);
    try {
      const data = await readJson(file);
      const fileBase = basename(file);
      const rows = Array.isArray(data?.records) ? data.records
        : Array.isArray(data?.tickers) ? data.tickers
        : Array.isArray(data?.rows) ? data.rows
        : [];
      for (const row of rows.slice(0, 220)) {
        const symbol = row?.symbol || row?.ticker || row?.asset || row?.primaryTicker || row?.canonicalTicker;
        addSymbol(scores, symbol, fileBase, socialPriorityForRecord(row, fileBase));
      }
      walkForSymbols(data, scores, fileBase, "", SOURCE_BASE_WEIGHTS.get(fileBase) || 1);
    } catch (error) {
      console.error(JSON.stringify({ level: "warn", message: "source_read_failed", file, error: error.message }));
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .map((item) => ({ symbol: item.symbol, score: item.score, sources: [...item.sources].sort() }));
}

function compactResult(result) {
  return {
    symbol: result.symbol,
    fetchedAt: result.fetchedAt,
    summary: result.summary,
    stocktwits: {
      ok: !result.stocktwits?.error,
      error: result.stocktwits?.error || null,
      cache: result.stocktwits?.cache || null,
      summary: result.stocktwits?.summary || null,
      topMessages: (result.stocktwits?.topMessages || []).slice(0, 10).map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        body: item.body,
        user: item.user?.username || null,
        sentiment: item.sentiment,
        likes: item.likes,
        url: item.id ? "https://stocktwits.com/symbol/" + encodeURIComponent(result.symbol) + "/message/" + encodeURIComponent(String(item.id)) : null
      }))
    },
    reddit: {
      ok: !result.reddit?.error,
      error: result.reddit?.error || null,
      cache: result.reddit?.cache || null,
      summary: result.reddit?.summary || null,
      errors: result.reddit?.errors || [],
      posts: (result.reddit?.posts || []).slice(0, 10).map((item) => ({
        subreddit: item.subreddit,
        title: item.title,
        updated: item.updated,
        link: item.link,
        author: item.author || null,
        sentiment: item.sentiment
      }))
    }
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function main() {
  const maxSymbols = toInt(getArg("max-symbols", process.env.MARKET_SOCIAL_PREFETCH_MAX_SYMBOLS), 12, 1, 60);
  const delayMs = toInt(getArg("delay-ms", process.env.MARKET_SOCIAL_PREFETCH_DELAY_MS), 5000, 0, 60000);
  const perSymbolTimeoutMs = toInt(getArg("per-symbol-timeout-ms", process.env.MARKET_SOCIAL_PREFETCH_PER_SYMBOL_TIMEOUT_MS), 120000, 15000, 300000);
  const redditCacheTtlMinutes = toInt(getArg("reddit-cache-ttl-minutes", process.env.MARKET_SOCIAL_PREFETCH_REDDIT_CACHE_TTL_MINUTES), 90, 5, 180);
  const sourceFiles = (getArg("source-files", process.env.MARKET_SOCIAL_PREFETCH_SOURCE_FILES || "") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const discovered = await discoverSymbols(sourceFiles.length ? sourceFiles : DEFAULT_SOURCE_FILES);
  const selected = discovered.slice(0, maxSymbols);
  const startedAt = new Date().toISOString();
  const results = [];

  for (const [index, item] of selected.entries()) {
    if (index && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const result = await withTimeout(fetchCombinedSocialSentiment({
        symbol: item.symbol,
        subreddits: DEFAULT_SUBREDDITS,
        stocktwitsLimit: 10,
        redditLimitPerSubreddit: 3,
        redditMaxPosts: 10,
        redditRequestDelayMs: 1500,
        redditCacheTtlMinutes,
        redditTimeWindow: "week"
      }), perSymbolTimeoutMs, "prefetch " + item.symbol);
      results.push({ ...compactResult(result), discovery: item });
      console.error(JSON.stringify({ level: "info", message: "prefetched", symbol: item.symbol, index: index + 1, total: selected.length, label: result.summary?.roughLabel }));
    } catch (error) {
      results.push({ symbol: item.symbol, discovery: item, error: error.message });
      console.error(JSON.stringify({ level: "warn", message: "prefetch_failed", symbol: item.symbol, error: error.message }));
    }
  }

  const snapshot = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    selected,
    sourceFiles: sourceFiles.length ? sourceFiles : DEFAULT_SOURCE_FILES,
    redditScope: DEFAULT_SUBREDDITS,
    results
  };

  await mkdir(join(SNAPSHOT_DIR, "history"), { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  await writeFile(join(SNAPSHOT_DIR, "prefetch-latest.json"), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  if (!getFlag("no-history")) {
    await writeFile(join(SNAPSHOT_DIR, "history", "market-social-prefetch-" + stamp + ".json"), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify({
    ok: true,
    startedAt,
    finishedAt: snapshot.finishedAt,
    symbols: selected.map((item) => item.symbol),
    resultCount: results.length,
    snapshot: join(SNAPSHOT_DIR, "prefetch-latest.json")
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
