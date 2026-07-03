# Whis Market Social Sentiment MCP

Read-only MCP server for collecting lightweight market sentiment context from public social sources.

This project is used by a private command-center workflow to summarize public ticker discussion for investment research review. It does not post, comment, vote, send messages, moderate communities, collect private user data, resell Reddit data, or train models.

## What It Does

- Reads public Stocktwits symbol streams.
- Reads public Reddit subreddit search feeds for ticker/company mentions while official Reddit Data API access is pending.
- Produces rough keyword sentiment summaries for human review.
- Caches repeated requests to avoid unnecessary source traffic.
- Applies request timeouts, low default limits, and Reddit request delays.
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
- Reddit subreddit requests are delayed by default.
- HTTP calls have a 12-second timeout.
- Reddit 429 Too Many Requests responses are retried once after a short delay.
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

## MCP Registration Example

```json
{
  "command": "/path/to/whis-market-social-sentiment-mcp/run.sh",
  "args": []
}
```

## Data Handling

This server returns public post/message excerpts and links for private human review. It does not persist raw source data to disk. The in-memory cache is process-local and expires automatically.

## Compliance Intent

This project is intended for low-volume, read-only, private/internal market sentiment research. It uses a unique User-Agent, narrow query scope, caching, backoff, and bounded result limits.
