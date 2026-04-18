---
title: About public-agent
---

# About public-agent

public-agent is a small HTTP server that exposes a safety-screened
conversational endpoint backed by a language model. It is designed for
public-facing deployments where anonymous callers can ask questions and
operators can review every exchange afterwards.

Every incoming message passes through a safety classifier before the main
model sees it. Messages classified as prompt-injection attempts or attempts
to extract system prompts are refused with a fixed reply. Ambiguous
messages are flagged for human review. Only messages classified as benign
reach the main model.

The agent can consult the operator's curated knowledge base through two
tools: a search tool that returns short snippets, and a read tool that
returns the full contents of a specific file. The agent cannot change
knowledge files, browse arbitrary paths, or reach the network beyond the
OpenRouter API.
