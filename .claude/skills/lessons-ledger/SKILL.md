---
name: lessons-ledger
description: Cross-run memory discipline for agents with a persistent workspace. Use at the end of any session where something non-obvious was learned (a correction from the user, a confirmed approach, a trap in the environment), and at the start of any task similar to past work. Trigger on user corrections, surprising failures, and hard-won configuration or debugging discoveries.
---

# Lessons Ledger

An agent that cannot remember its corrections repeats them. Keep a ledger of lessons in the workspace (a `lessons/` directory or the project's designated memory location) and treat it as part of the codebase: referenced, updated, and pruned.

## Writing a lesson

1. **One lesson per file, summary on top.** Each file holds exactly one fact or rule, with a one-line summary as its first line so a future scan of the directory reads like an index.
2. **Record corrections and confirmations alike.** A lesson is either "this failed and here is why" or "this approach was confirmed to work and here is why it mattered." Both prevent re-derivation. Include the why: a rule without its reason gets misapplied.
3. **The bar for saving:** would a future session, starting cold, do the wrong thing without this note? If yes, save it. If the repo, the docs, or the chat history already record it, do not duplicate it; the ledger is for what is written down nowhere else.
4. **Convert relative time to absolute.** "Last week" is meaningless in three months. Dates, versions, and exact identifiers.

## Maintaining the ledger

1. **Update instead of duplicating.** Before writing a new lesson, check whether an existing one covers the territory. Extend or correct that file rather than adding a near-copy beside it.
2. **Delete wrong lessons.** When a recorded lesson turns out to be false or obsolete, remove it in the same session you discover this. A stale ledger is worse than no ledger, because it is trusted.
3. **Verify before applying.** A lesson describes what was true when written. If it names a file, flag, or API, confirm that thing still exists before recommending or acting on it.

## Using the ledger

1. **Read before similar work.** At the start of a task, scan the summaries for anything touching the same system, tool, or failure class. Thirty seconds of reading routinely saves the hour the original lesson cost.
2. **Bootstrap from history.** When first setting up a ledger on an existing project, review past sessions or commit history for recurring corrections and themes, and seed the ledger with them, so it starts useful instead of empty.

## Why this matters

Within one session, a model learns; across sessions, it forgets everything not written down. The ledger converts one-time costs (a debugging dead end, a user correction, an environment quirk) into permanent capability. Agents with a maintained ledger visibly improve week over week. Agents without one make the same mistake with the same confidence every time.
