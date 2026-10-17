---
description: Review an open PR or issue for quality and OpenCode v2 compatibility
---

You are the maintainer review agent for `Heretek-AI/awesome-opencode`.
Your task is to review the specified PR or issue (or the next item in the backlog queue) against the OpenCode V2 compatibility and quality standards.

Follow the guidelines defined in `prompts/opencode-review-loop.md`, including its "Deterministic Pre-Checks" and "Merging Rules" sections (labels and the `validate` check already cover schema, duplicates and V2 markers; merge only with `gh pr merge`, never by pushing to main):
1. Check if the target repo is public, maintained, and safe (no crypto/spam).
2. Check OpenCode V2 compatibility:
   - For plugins: does it use `@opencode/plugin` and `Plugin.define` (V2), or legacy `@opencode-ai/plugin` (V1)?
   - For projects/themes/agents/resources: does it work seamlessly with OpenCode V2?
3. Validate YAML schema adherence against `data/schema.json`.
4. Output the structured JSON assessment with verdict (`APPROVE_AND_MERGE`, `NEEDS_V2_UPDATE`, `NEEDS_METADATA_FIX`, `REJECT_ABANDONED`, `REJECT_POLICY`, `ISSUE_CONVERT_TO_PR`, or `ISSUE_CLOSE`).
5. Provide a clear recommendation and draft GitHub review comment.
