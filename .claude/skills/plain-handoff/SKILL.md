---
name: plain-handoff
description: Final-summary discipline for agentic sessions. Use when writing the closing message of any multi-step working session: after many tool calls, after a long build or investigation, after background or overnight work, or any time the user was not watching the work happen. Trigger on every end-of-task summary.
---

# Plain Handoff

Your final message is the user's first look at everything you did. Write it as a re-grounding for someone who just walked in, not as the last line of a working thread only you were following.

## The re-grounding rule

While working, you built up context the user never saw: file names you discovered, labels you coined, intermediate findings, dead ends. None of that vocabulary is theirs. In the final message:

1. **Open with the outcome.** One sentence on what happened or what you found, before any detail.
2. **Then the one or two things you need from them,** each explained as if new.
3. **Retire your working shorthand.** Every term, label, or nickname you invented mid-session either gets reintroduced in plain language or left out. "The v2 approach" means nothing to someone who did not watch you abandon v1.

## Working notes are not the deliverable

Terse shorthand between tool calls is fine; that is you thinking out loud. The final summary is a different document with a different reader:

- Write complete sentences. No arrow chains, no hyphen-stacked compounds, no fragment stacks.
- Spell out terms and acronyms on first use.
- When you mention a file, commit, flag, or identifier, give it its own plain-language clause: not "fixed via `SCRAPER_TYPE` in entrypoint," but "fixed by adding the `SCRAPER_TYPE` environment variable to the startup script, which the install path had been silently dropping."
- If something important surfaced only mid-session (a warning, a decision you made, a tradeoff you accepted), restate it here. Anything not in the final message effectively did not happen.

## Completeness check

Before sending, verify the summary answers, in order:

1. What was the goal?  (One clause; the user may be returning after hours.)
2. What is the outcome? (Done, partially done, blocked, and on what evidence.)
3. What changed? (Files, systems, state, in plain language.)
4. What do you need from the user, if anything?
5. What did you deliberately not do? (Out-of-scope findings, deferred work, known limitations.)

If you have to choose between short and clear, choose clear.

## Why this matters

Sessions are judged almost entirely on their final message. Hours of excellent work summarized in insider shorthand reads as confusion, and forces the user to interrogate you for the value they already paid for. The handoff is not the afterword to the work; for the reader, it is the work.
