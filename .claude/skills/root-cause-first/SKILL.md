---
name: root-cause-first
description: Debugging discipline. Use whenever diagnosing a bug, error, test failure, crash, regression, flaky behavior, or unexpected output, and especially before applying any fix. Also trigger when a previous fix attempt did not work and another attempt is about to be made.
---

# Root Cause First

Fix causes, not symptoms. A fix applied to an undiagnosed problem is a guess, and guesses compound: each one changes the system, making the real cause harder to see.

## Before you fix anything

1. **Reproduce it.** Run the failing thing and watch it fail. If you cannot reproduce the failure, you cannot know your fix works, and you say so instead of claiming a fix.
2. **Trace it.** Follow the failure from the symptom back to the cause: read the actual error, read the code path that produced it, inspect the actual state (logs, variables, files, network) rather than assuming it. Stop tracing only when you can explain the mechanism: "X happens because Y does Z."
3. **Beware pattern-matching.** A signal that pattern-matches a known failure may have a different cause. "This looks like the usual CORS issue" is a hypothesis, not a diagnosis. Verify the mechanism before acting on the resemblance, especially before any state-changing action like a restart, delete, or config edit.
4. **Then fix the cause.** If the honest fix is upstream (a data problem, a wrong assumption in a caller, a stale dependency), fix it there. Do not patch the symptom downstream and call it done. If a downstream patch is genuinely the right short-term call, label it a bridge and state the debt it creates.

## The failed-approach ledger

When a fix attempt fails, write down (in a scratch file or your working notes) before doing anything else:

- What you tried
- What you expected
- What actually happened
- What this rules out

Then, and only then, form the next hypothesis. The ledger exists to enforce one rule: **never retry a failed approach verbatim.** If you find yourself making the same edit a second time, or re-running the same command hoping for a different result, stop. That is the signal you are guessing.

## The two-failure rule

After two failed fix attempts, stop fixing and restart diagnosis from scratch:

1. Re-read the original error with fresh eyes. The answer is often in a line you skimmed.
2. Question your framing: is the bug even where you think it is? Check one layer up and one layer down.
3. Shrink the reproduction: find the smallest input or code path that still fails.
4. If available, hand the evidence (not your theory) to a fresh-context subagent and ask it to diagnose independently. Your accumulated assumptions are now part of the problem.

## Why this matters

The most expensive debugging sessions are not the hard bugs. They are the easy bugs treated with a sequence of confident guesses, each of which added noise. Diagnosis feels slower than guessing and is almost always faster.
