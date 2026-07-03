#!/usr/bin/env node
import { fetchCombinedSocialSentiment, fetchRedditTickerSentiment, fetchStocktwitsSymbolSentiment } from "../server.mjs";

const symbol = process.argv[2] || "NVDA";
const company = process.argv[3] || "NVIDIA";

const stocktwits = await fetchStocktwitsSymbolSentiment({ symbol, limit: 5 });
let reddit;
try {
  reddit = await fetchRedditTickerSentiment({ symbol, company, subreddits: ["stocks"], limitPerSubreddit: 3, maxPosts: 6, requestDelayMs: 2000 });
} catch (error) {
  reddit = {
    posts: [],
    summary: { itemCount: 0, roughScore: 0, roughLabel: "unavailable" },
    errors: [{ subreddit: "stocks", error: error.message }]
  };
}
const combined = {
  summary: {
    itemCount: stocktwits.summary.itemCount + reddit.summary.itemCount,
    roughScore: stocktwits.summary.roughScore + reddit.summary.roughScore,
    sources: {
      stocktwits: stocktwits.summary.roughLabel,
      reddit: reddit.summary.roughLabel
    }
  }
};

console.log(JSON.stringify({
  ok: true,
  symbol,
  stocktwits: { count: stocktwits.messages.length, label: stocktwits.summary.roughLabel },
  reddit: { count: reddit.posts.length, label: reddit.summary.roughLabel, errors: reddit.errors },
  combined: combined.summary
}, null, 2));
