---
name: Never remove tests without reason
description: When updating tests, preserve all existing test cases — only update signatures/values, don't drop coverage
type: feedback
---

Never remove existing tests when refactoring. Update them to match new APIs (constructor signatures, JID formats, etc.) but keep all test cases intact. Test coverage must not decrease.

**Why:** Removing tests silently drops coverage, and the user expects test count to stay the same or increase.

**How to apply:** When updating test files, use targeted edits (Edit tool) to change specific values/signatures rather than rewriting entire files. Only add new tests, never remove existing ones unless explicitly asked.
