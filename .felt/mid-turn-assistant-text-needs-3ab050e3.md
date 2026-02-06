---
title: Mid-turn assistant text needs PostToolUse transcript scan
status: closed
kind: decision
priority: 2
depends-on:
    - posttooluse-hook-for-real-time-1351fd74
created-at: 2026-02-06T17:24:58.465778+01:00
closed-at: 2026-02-06T17:24:58.465783+01:00
close-reason: 'PostToolUse was only sending tool_use + tool_result from the event payload. Assistant text blocks BETWEEN tool uses had no delivery mechanism — Stop only fires once at end of turn, so mid-turn text was invisible until then (or until next UserPromptSubmit fallback). Fix: PostToolUse now scans tail -n 30 of transcript for text/thinking blocks, filtered to exclude tool_use (already in payload). Server dedup handles overlap with previous POSTs. Also: Stop curl made synchronous (was backgrounded, risked dying on process exit), JQ unique_by includes timestamp (prevented same-content text blocks from collapsing), within-batch dedup added to ConversationCache, chronological sort on insert/restore, debounced persist after addMessages.'
---
