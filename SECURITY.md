# Security

Do not commit credentials, tokens, .env files, Reddit client secrets, or private command-center configuration to this repository.

This server is intended to run as a local MCP process. It exposes read-only tools and does not require secrets for its current RSS/Stocktwits mode.

If OAuth support is added later, load credentials from a secret manager or environment variables and keep them out of git.
