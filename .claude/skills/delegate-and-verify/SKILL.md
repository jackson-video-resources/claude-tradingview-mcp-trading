---
name: delegate-and-verify
description: Subagent orchestration and verification discipline. Use whenever a task has independent subtasks that could run in parallel, whenever work is substantial enough to need checking before it ships, and whenever tempted to review your own work by re-reading it. Trigger on multi-file changes, audits, migrations, reviews, and any long-running build.
---

# Delegate and Verify

Two disciplines that compound: fan independent work out to subagents instead of doing everything serially, and verify finished work with a fresh context instead of your own re-reading.

## Delegation

1. **Spot independence early.** Before starting a multi-part task, ask: which parts share no state? Searching three subsystems, updating twelve call sites, auditing pages against a checklist: these are fan-outs, not sequences.
2. **Delegate and keep working.** Dispatch subagents for the independent parts and continue on the parts only you can do. Do not sit idle waiting on a subagent unless its result gates everything else.
3. **Brief like a handoff.** A subagent knows nothing you do not tell it. Give it the goal, the constraints, the file paths, and what a good answer looks like. A vague brief returns vague work, and re-briefing costs more than briefing well once.
4. **Intervene on drift.** If a subagent's output shows it misunderstood the goal or lacks context, correct it or re-dispatch. Do not silently absorb wrong work into the result.

## Verification

**Fresh-context verifiers outperform self-critique.** When you review your own work, you re-read it with the same assumptions that produced it, so you confirm rather than check. A verifier that never saw your reasoning has no such blind spot.

1. **Give the verifier the spec and the artifact, never your reasoning.** It gets the original requirement and the finished work. It does not get your explanation of why the work is correct; that explanation is exactly the bias you are paying to remove.
2. **Ask it to break the work, not bless it.** "Try to refute this" or "find the inputs where this fails" produces findings. "Does this look right?" produces agreement.
3. **On long autonomous runs, verify on an interval.** Establish a method for checking your work as you build, and run it at a fixed cadence (every N subtasks, every major milestone) with subagents verifying against the specification. Do not save all verification for the end, where a foundational error costs the entire run.
4. **A clean review of risky work is itself a flag.** If a verifier finds nothing wrong with a large, complex, or security-sensitive change, consider whether the verifier was briefed well enough to find anything, before considering the work clean.

## Why this matters

Serial work wastes the hours that parallel work recovers, and self-review is the weakest form of review that exists. The combination, parallel builders plus adversarial fresh-context checkers, is how a single orchestrating agent produces work at a quality that self-directed effort cannot reach.
