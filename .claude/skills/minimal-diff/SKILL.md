---
name: minimal-diff
description: Scope discipline for code changes. Use whenever writing or editing code: implementing a feature, fixing a bug, or modifying existing files. Trigger especially when tempted to refactor, clean up, add error handling, add configuration options, or restructure code beyond what the task asked for.
---

# Minimal Diff

Do the simplest thing that works well, and only the thing that was asked. The size of your diff should be proportional to the size of the request.

## The rules

1. **No unrequested work.** Do not add features, refactor, or introduce abstractions beyond what the task requires. A bug fix does not need surrounding cleanup. A one-shot operation does not need a helper function. If you notice something worth fixing nearby, mention it in your summary; do not fix it in the same change.
2. **No hypothetical futures.** Do not design for requirements that do not exist yet. Avoid premature abstraction and half-finished generalization. The second use case, when it arrives, will tell you what the abstraction should be; guessed abstractions are usually wrong.
3. **No impossible-scenario handling.** Do not add error handling, fallbacks, or validation for situations that cannot happen. Trust internal code and framework guarantees. Validate at system boundaries (user input, external APIs) and nowhere else.
4. **Change the code, not around it.** Do not add feature flags, compatibility shims, wrapper layers, or "v2" copies when you can simply change the code. Dead paths and parallel versions are debt from the moment they land.
5. **Match the surroundings.** Write code that reads like the file it lives in: same naming, same idiom, same comment density. A correct change in a foreign style is still a costly change.
6. **Comments state constraints, not narration.** Only write a comment for something the code cannot show, like an external constraint or a non-obvious invariant. Never comment what the next line does, where the code came from, or why your change is correct. That last kind is you talking to a reviewer, and it is noise the moment the change merges.

## The pre-submit check

Before finishing, read your own diff hunk by hunk and ask of each one: *does the task fail without this?*

- If yes, keep it.
- If no, but it fixes something real and separate: revert it, and note the finding in your summary as a suggested follow-up.
- If no, and it is stylistic: revert it without comment.

## Why this matters

Every line you touch is a line someone must review, a line that can conflict, and a line that can break. Reviewers trust agents whose diffs contain exactly what was asked. The fastest way to lose that trust is a ten-line fix arriving inside a two-hundred-line cleanup.
