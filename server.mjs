#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const STOCKTWITS_API = "https://api.stocktwits.com/api/2";
const REDDIT_BASE = "https://www.reddit.com";
const USER_AGENT = "WhisMarketSocialSentiment/1.0 (read-only council review)";
const HTTP_TIMEOUT_MS = 12000;
const CACHE = new Map();
const DEFAULT_STOCKTWITS_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_REDDIT_CACHE_MS = 45 * 60 * 1000;
const DEFAULT_SUBREDDITS = ["stocks", "investing", "wallstreetbets", "SecurityAnalysis"];
const BULLISH_TERMS = ["bullish", "breakout", "buy", "bought", "accumulate", "long", "upside", "beat", "upgrade", "strong", "growth", "momentum", "rally", "calls", "undervalued", "guidance raise", "raised guidance", "record revenue", "free cash flow", "margin expansion", "squeeze"];
const BEARISH_TERMS = ["bearish", "breakdown", "sell", "sold", "short", "downside", "miss", "downgrade", "weak", "risk", "lawsuit", "fraud", "puts", "crash", "overvalued", "bubble", "dilution", "guidance cut", "lowered guidance", "margin compression", "debt risk"];

function cleanSymbol(symbol) {
  const value = String(symbol || "").trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9._-]{1,16}$/.test(value)) throw new Error("Symbol must be a ticker-like value.");
  return value;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

async function cached(key, ttlMs, load) {
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && hit.expiresAt > now) {
    return { ...hit.value, cache: { hit: true, key, expiresAt: new Date(hit.expiresAt).toISOString() } };
  }
  const value = await load();
  CACHE.set(key, { value, expiresAt: now + ttlMs });
  return { ...value, cache: { hit: false, key, expiresAt: new Date(now + ttlMs).toISOString() } };
}

function scoreText(text) {
  const lower = cleanText(text).toLowerCase();
  let bullishHits = 0;
  let bearishHits = 0;
  for (const term of BULLISH_TERMS) if (lower.includes(term)) bullishHits += 1;
  for (const term of BEARISH_TERMS) if (lower.includes(term)) bearishHits += 1;
  const score = bullishHits - bearishHits;
  const label = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  return { label, score, bullishHits, bearishHits };
}

function aggregate(items, scoreField = "sentiment") {
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  let score = 0;
  for (const item of items) {
    const sentiment = item[scoreField] || scoreText(item.text || item.title || "");
    counts[sentiment.label] = (counts[sentiment.label] || 0) + 1;
    score += Number(sentiment.score || 0);
  }
  return {
    itemCount: items.length,
    counts,
    roughScore: score,
    roughLabel: score > 2 ? "bullish" : score < -2 ? "bearish" : "mixed/neutral"
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } });
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.errors?.[0]?.message || data?.message || data?.raw?.slice?.(0, 160) || res.statusText;
    throw new Error("HTTP " + res.status + ": " + msg);
  }
  return data;
}

async function fetchText(url, accept = "application/atom+xml, application/xml, text/xml, */*") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT, "Accept": accept } });
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (text.slice(0, 160).replace(/\s+/g, " ") || res.statusText));
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRedditFeed(url) {
  try {
    return await fetchText(url);
  } catch (error) {
    if (!String(error.message || "").includes("HTTP 429")) throw error;
    await sleep(2500);
    return await fetchText(url);
  }
}

export async function fetchStocktwitsSymbolSentiment(args) {
  const symbol = cleanSymbol(args.symbol);
  const limit = clampInt(args.limit, 5, 30, 20);
  const cacheTtlMs = clampInt(args.cacheTtlMinutes, 1, 60, DEFAULT_STOCKTWITS_CACHE_MS / 60000) * 60 * 1000;
  const cacheKey = "stocktwits:" + stableJson({ symbol, limit });
  return cached(cacheKey, cacheTtlMs, async () => {
  const url = new URL(STOCKTWITS_API + "/streams/symbol/" + encodeURIComponent(symbol) + ".json");
  url.searchParams.set("limit", String(limit));
  const data = await fetchJson(url);
  const messages = (data.messages || []).slice(0, limit).map((message) => {
    const body = cleanText(message.body);
    const explicit = String(message.entities?.sentiment?.basic || "").toLowerCase();
    const keyword = scoreText(body);
    const sentiment = explicit === "bullish"
      ? { label: "bullish", score: Math.max(1, keyword.score), source: "stocktwits-explicit", keyword }
      : explicit === "bearish"
        ? { label: "bearish", score: Math.min(-1, keyword.score), source: "stocktwits-explicit", keyword }
        : { ...keyword, source: "keyword" };
    return {
      id: message.id,
      createdAt: message.created_at,
      body,
      user: message.user ? { id: message.user.id, username: message.user.username, followers: message.user.followers, ideas: message.user.ideas } : null,
      sentiment,
      likes: message.likes?.total || 0,
      source: "stocktwits"
    };
  });
  const summary = aggregate(messages);
  const explicitCounts = { bullish: 0, bearish: 0, none: 0 };
  for (const item of messages) {
    if (item.sentiment.source === "stocktwits-explicit") explicitCounts[item.sentiment.label] += 1;
    else explicitCounts.none += 1;
  }
  return {
    source: "stocktwits",
    symbol,
    fetchedAt: new Date().toISOString(),
    symbolMeta: data.symbol ? { title: data.symbol.title, exchange: data.symbol.exchange, watchlistCount: data.symbol.watchlist_count, hasPricing: data.symbol.has_pricing } : null,
    cursor: data.cursor || null,
    summary: { ...summary, explicitCounts, note: "Stocktwits explicit tags are used when present; remaining messages use a rough keyword screen." },
    topMessages: messages.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10),
    messages
  };
  });
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function redditEntryToPost(entry, subreddit) {
  const title = cleanText(entry.title);
  const content = cleanText(entry.content || entry.summary || "");
  const authorName = cleanText(entry.author?.name || entry.author || "");
  const link = normalizeArray(entry.link).find((item) => item?.["@_href"])?.["@_href"] || entry.link?.["@_href"] || "";
  const text = title + " " + content;
  return {
    source: "reddit",
    subreddit,
    id: entry.id || link || title,
    title,
    content: content.slice(0, 700),
    author: authorName.replace(/^\/?u\//, ""),
    updated: entry.updated || entry.published || null,
    link,
    sentiment: scoreText(text)
  };
}

export async function fetchRedditTickerSentiment(args) {
  const symbol = cleanSymbol(args.symbol);
  const company = cleanText(args.company || "");
  const limitPerSubreddit = clampInt(args.limitPerSubreddit, 3, 15, 8);
  const subreddits = normalizeArray(args.subreddits).length
    ? normalizeArray(args.subreddits).map((item) => String(item).replace(/^r\//, "").trim()).filter(Boolean).slice(0, 12)
    : DEFAULT_SUBREDDITS;
  const requestDelayMs = clampInt(args.requestDelayMs, 0, 5000, 1250);
  const query = company ? "(" + symbol + " OR " + company + ")" : symbol;
  const cacheTtlMs = clampInt(args.cacheTtlMinutes, 5, 180, DEFAULT_REDDIT_CACHE_MS / 60000) * 60 * 1000;
  const cacheKey = "reddit:" + stableJson({
    symbol,
    company,
    limitPerSubreddit,
    subreddits,
    maxPosts: args.maxPosts,
    sort: args.sort || "new",
    timeWindow: args.timeWindow || "week"
  });
  return cached(cacheKey, cacheTtlMs, async () => {
  const parser = new XMLParser({ ignoreAttributes: false });
  const posts = [];
  const errors = [];
  for (const subreddit of subreddits) {
    const url = new URL(REDDIT_BASE + "/r/" + encodeURIComponent(subreddit) + "/search.rss");
    url.searchParams.set("q", query);
    url.searchParams.set("restrict_sr", "on");
    url.searchParams.set("sort", args.sort || "new");
    url.searchParams.set("t", args.timeWindow || "week");
    try {
      if (posts.length || errors.length) await sleep(requestDelayMs);
      const xml = await fetchRedditFeed(url);
      const parsed = parser.parse(xml);
      const entries = normalizeArray(parsed.feed?.entry).slice(0, limitPerSubreddit);
      for (const entry of entries) posts.push(redditEntryToPost(entry, subreddit));
    } catch (error) {
      errors.push({ subreddit, error: error.message });
    }
  }
  const summary = aggregate(posts);
  return {
    source: "reddit-rss",
    symbol,
    company: company || null,
    query,
    subreddits,
    fetchedAt: new Date().toISOString(),
    summary: { ...summary, note: "Reddit uses public Atom/RSS search because unauthenticated Reddit JSON is blocked from this host. Sentiment is a rough keyword screen." },
    posts: posts.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || ""))).slice(0, clampInt(args.maxPosts, 5, 60, 30)),
    errors
  };
  });
}

export async function fetchCombinedSocialSentiment(args) {
  const symbol = cleanSymbol(args.symbol);
  const company = cleanText(args.company || "");
  const [stocktwits, reddit] = await Promise.allSettled([
    fetchStocktwitsSymbolSentiment({ symbol, limit: args.stocktwitsLimit ?? 20 }),
    fetchRedditTickerSentiment({
      symbol,
      company,
      subreddits: args.subreddits,
      limitPerSubreddit: args.redditLimitPerSubreddit ?? 6,
      maxPosts: args.redditMaxPosts ?? 24,
      timeWindow: args.redditTimeWindow || "week",
      requestDelayMs: args.redditRequestDelayMs ?? 1500,
      cacheTtlMinutes: args.redditCacheTtlMinutes ?? 45
    })
  ]);
  const result = {
    source: "market-social-sentiment",
    symbol,
    company: company || null,
    fetchedAt: new Date().toISOString(),
    stocktwits: stocktwits.status === "fulfilled" ? stocktwits.value : { error: stocktwits.reason?.message || String(stocktwits.reason) },
    reddit: reddit.status === "fulfilled" ? reddit.value : { error: reddit.reason?.message || String(reddit.reason) },
    councilUse: "Use as a sentiment/context layer only. Do not treat rough social scoring as a standalone buy/sell signal."
  };
  const sourceSummaries = [result.stocktwits?.summary, result.reddit?.summary].filter(Boolean);
  const totalCount = sourceSummaries.reduce((sum, item) => sum + (item.itemCount || 0), 0);
  const totalScore = sourceSummaries.reduce((sum, item) => sum + (item.roughScore || 0), 0);
  result.summary = {
    itemCount: totalCount,
    roughScore: totalScore,
    roughLabel: totalScore > 3 ? "bullish" : totalScore < -3 ? "bearish" : "mixed/neutral",
    sources: {
      stocktwits: result.stocktwits?.summary?.roughLabel || result.stocktwits?.error || "unavailable",
      reddit: result.reddit?.summary?.roughLabel || result.reddit?.error || "unavailable"
    }
  };
  return result;
}

const server = new McpServer({ name: "market-social-sentiment", version: "1.0.0" });

server.registerTool("stocktwits_symbol_sentiment", {
  title: "Stocktwits Symbol Sentiment",
  description: "Read-only Stocktwits symbol stream sentiment for council review. Does not post or mutate anything.",
    inputSchema: { symbol: z.string(), limit: z.number().int().min(5).max(30).optional() }
}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await fetchStocktwitsSymbolSentiment(args), null, 2) }] }));

server.registerTool("reddit_ticker_sentiment", {
  title: "Reddit Ticker Sentiment",
  description: "Read-only Reddit public RSS search across market subreddits for rough ticker narrative/sentiment.",
  inputSchema: {
    symbol: z.string(),
    company: z.string().optional(),
    subreddits: z.array(z.string()).optional(),
    limitPerSubreddit: z.number().int().min(3).max(15).optional(),
    maxPosts: z.number().int().min(5).max(60).optional(),
    requestDelayMs: z.number().int().min(0).max(5000).optional(),
    cacheTtlMinutes: z.number().int().min(5).max(180).optional(),
    timeWindow: z.enum(["hour", "day", "week", "month", "year", "all"]).optional(),
    sort: z.enum(["new", "relevance", "top", "comments"]).optional()
  }
}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await fetchRedditTickerSentiment(args), null, 2) }] }));

server.registerTool("market_social_sentiment", {
  title: "Combined Market Social Sentiment",
  description: "Combines read-only Stocktwits and Reddit sentiment/narrative context for a ticker.",
  inputSchema: {
    symbol: z.string(),
    company: z.string().optional(),
    subreddits: z.array(z.string()).optional(),
    stocktwitsLimit: z.number().int().min(5).max(30).optional(),
    redditLimitPerSubreddit: z.number().int().min(3).max(15).optional(),
    redditMaxPosts: z.number().int().min(5).max(60).optional(),
    redditRequestDelayMs: z.number().int().min(0).max(5000).optional(),
    redditCacheTtlMinutes: z.number().int().min(5).max(180).optional(),
    redditTimeWindow: z.enum(["hour", "day", "week", "month", "year", "all"]).optional()
  }
}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await fetchCombinedSocialSentiment(args), null, 2) }] }));

if (import.meta.url === "file://" + process.argv[1]) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
