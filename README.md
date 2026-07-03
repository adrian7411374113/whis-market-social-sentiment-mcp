# Whis Market Social Sentiment MCP

Read-only MCP server for collecting lightweight market sentiment context from public social sources.

This project is used by a private command-center workflow to summarize public ticker discussion for investment research review. It does not post, comment, vote, send messages, moderate communities, collect private user data, resell Reddit data, or train models.

## What It Does

- Reads public Stocktwits symbol streams.
- Reads public Reddit subreddit search feeds for ticker/company mentions while official Reddit Data API access is pending.
- Produces rough keyword sentiment summaries for human review.
- Caches repeated requests to avoid unnecessary source traffic, including a disk-backed process restart cache.
- Includes an optional prefetch job that warms cache for active council/watchlist tickers.
- Applies request timeouts, low default limits, and Reddit request delays.
- Falls back to stale cached Reddit data if Reddit rate-limits or times out.
- Exposes the data through read-only MCP tools.

## Reddit API Access Status

This repository is prepared for Reddit developer review. The current Reddit path uses public Atom/RSS search as a low-volume fallback because unauthenticated Reddit JSON requests are unreliable from server environments.

If Reddit Data API access is approved, Reddit reads should be moved behind registered OAuth/Data API credentials and continue to use the same conservative controls: narrow subreddit scope, ticker-specific queries, caching, request delays, and rate-limit backoff.

## What It Does Not Do

- No Reddit write actions.
- No posting, commenting, voting, messaging, following, or moderation.
- No scraping of private or authenticated-only user data.
- No persistent storage of raw Reddit data by default.
- No automated trading.
- No resale or redistribution of Reddit content.
- No model training.

## MCP Tools

- stocktwits_symbol_sentiment
  - Reads Stocktwits messages for a ticker symbol.
  - Uses Stocktwits explicit bullish/bearish tags when present, otherwise a small keyword screen.

- reddit_ticker_sentiment
  - Reads Reddit public Atom/RSS search results for selected finance subreddits while Data API access is pending.
  - Defaults to a small subreddit set and caches ticker/subreddit searches.

- market_social_sentiment
  - Combines Stocktwits and Reddit summaries into one council-review payload.

## Default Reddit Scope

The default Reddit subreddit set is intentionally narrow:

- r/stocks
- r/investing
- r/wallstreetbets
- r/SecurityAnalysis

Searches are ticker/company-specific and intended for final candidate review, not broad platform crawling.

## Rate Limit Controls

The server is designed to be conservative:

- Reddit requests default to a 45-minute cache TTL.
- Stocktwits requests default to a 5-minute cache TTL.
- Cache entries are written to a local ignored cache directory by default.
- Reddit subreddit requests are delayed by default.
- HTTP calls have a 12-second timeout.
- Reddit 429 Too Many Requests responses are retried once after a short delay.
- If Reddit still fails and a prior cache entry exists, the server can return marked stale data instead of making repeated live calls.
- Tool schemas expose cache TTL and limit options with bounded min/max values.

## Install

```bash
npm install
```

## Run

```bash
node server.mjs
```

Or:

```bash
./run.sh
```

## Smoke Test

```bash
npm run smoke -- NVDA NVIDIA
```

The smoke test uses small limits and one Reddit subreddit.

## Optional Prefetch

```bash
npm run prefetch -- --max-symbols=12
```

The prefetch script discovers active symbols from local market review JSON files when available, fetches them sequentially, warms the disk cache, and writes an ignored `snapshots/prefetch-latest.json` file for private council review. You can also pass explicit symbols:

```bash
npm run prefetch -- --symbols=NVDA,TSLA --max-symbols=2 --no-history
```

## MCP Registration Example

```json
{
  "command": "/path/to/whis-market-social-sentiment-mcp/run.sh",
  "args": []
}
```

## Data Handling

This server returns public post/message excerpts and links for private human review.

The disk cache stores only bounded tool response payloads for ticker/subreddit queries, expires automatically, and is ignored by git.

Prefetch snapshots are local/private operational artifacts and are ignored by git.

## Compliance Intent

This project is intended for low-volume, read-only, private/internal market sentiment research. It uses a unique User-Agent, narrow query scope, caching, backoff, and bounded result limits.
