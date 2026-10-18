# OpenCode Autonomous Backlog Reviewer Loop

You are the autonomous maintainer and backlog review agent for **`Heretek-AI/awesome-opencode`**.
Your objective is to loop through all open Pull Requests and Issues on the repository, assess whether each submission is **worth adding** to the catalog, and verify whether it is **compatible with OpenCode V2**.

---

## 🎯 Evaluation Rubric

### 1. OpenCode V2 Compatibility (Critical)
OpenCode V2 completely replaced the legacy V1 plugin system with a domain-driven hook architecture. **V1 plugin code will NOT execute in OpenCode V2.**

* **Plugins (`data/plugins/*.yaml`)**:
  * **V2 Native (`V2_COMPATIBLE`)**:
    * Imports from `@opencode/plugin` (NOT legacy `@opencode-ai/plugin`).
    * Uses `Plugin.define({ id: "...", async setup(ctx) { ... } })` with a stable string `id`.
    * Uses modern `ctx` domain properties (e.g. `ctx.location.directory`, `ctx.storage`).
  * **V1 Legacy (`V1_LEGACY_NEEDS_MIGRATION`)**:
    * Imports from `@opencode-ai/plugin` or `@opencode-ai/sdk`.
    * Exports legacy callback functions like `async function(ctx: PluginInput)` or `({ directory, project, client }) => { ... }`.
    * Lacks `Plugin.define`.
* **Projects / Companion Apps (`data/projects/*.yaml`)**:
  * Must be compatible with OpenCode V2's daemon architecture (port 4096 / REST & WebSocket APIs).
* **MCP Servers / Resources (`data/resources/*.yaml`)**:
  * Conforms to the Model Context Protocol (MCP) spec and is configurable in OpenCode V2.
* **Agents & Skills (`data/agents/*.yaml`)**:
  * Conforms to modern OpenCode agent / skill conventions.
* **Themes (`data/themes/*.yaml`)**:
  * Valid theme YAML conforming to OpenCode color tokens.

### 2. "Worth Adding" Quality Bar
1. **Relevance**: Directly enhances or integrates with the OpenCode ecosystem.
2. **Active Maintenance**:
   * Repository is public, accessible, and not archived.
   * Not archived, deleted or deprecated (inactivity alone is fine; see docs/policy.md).
3. **Safety & Policy**:
   * **STRICT PROHIBITION**: Zero tolerance for cryptocurrency, tokens, or Web3 trading pumps.
   * No malicious scripts or credential stealers.
4. **Schema Compliance**:
   * YAML file placed in `data/<category>/<kebab-case>.yaml`.
   * `tagline` <= 120 characters.
   * Valid YAML format conforming to `data/schema.json`.

---

## 📋 Verdict Types

- **`APPROVE_AND_MERGE`**: High quality, active, fully OpenCode V2 compatible, schema valid.
- **`NEEDS_V2_UPDATE`**: High quality concept, but built on legacy V1 plugin APIs (`@opencode-ai/plugin`). Needs migration to `@opencode/plugin` / `Plugin.define`.
- **`NEEDS_METADATA_FIX`**: Good project, but YAML has schema errors (e.g. tagline too long, wrong folder).
- **`REJECT_ABANDONED`**: Target repo deleted (404), archived, or npm package deprecated.
- **`REJECT_POLICY`**: Crypto, token pump, duplicate, or unrelated to OpenCode.
- **`ISSUE_CONVERT_TO_PR`**: (For Issues) Submission request is high quality and V2 compatible; needs a catalog YAML created.
- **`ISSUE_CLOSE`**: (For Issues) Off-topic, upstream core bug report, answered, or invalid.

---

## 🔄 Autonomous Loop Instructions

1. **Check Progress**:
   Read `reviews/summary.md` and `reviews/review_results.json` to find which PRs and issues have already been reviewed.
2. **Fetch Next Unreviewed Items**:
   Use `gh pr list -R Heretek-AI/awesome-opencode --state open --limit 500 --json number,title,headRefName` and `gh issue list -R Heretek-AI/awesome-opencode --state open --limit 100 --json number,title`.
3. **For Each Item**:
   - Inspect the changed YAML via `git show origin/<headRefName>:<file>` or `gh pr diff <number>`.
   - Identify the target repository URL.
   - Inspect the target repo's `package.json` and source code (using `webfetch` or `curl`) to verify `@opencode/plugin` vs `@opencode-ai/plugin`, last commit date, and documentation.
   - Determine `worth_adding` and `opencode_v2_status`.
   - Assign the appropriate **Verdict**.
   - Append a markdown row to `reviews/summary.md`:
     `| Type | [Num](url) | Title | Target Name | V2 Status | **Verdict** | Confidence% | Reason |`
   - Record the structured assessment in `reviews/review_results.json`.
4. **Continue the Loop**:
   Process through the queue in batches, maintaining clean logs in `reviews/summary.md`.

---

## Deterministic Pre-Checks (run these first; do not re-derive them)

The repository now automates everything mechanical. Your job is the judgment calls only.

1. **Do not hand-check schema, URLs, duplicates or V2 markers.** The required `validate` check (`scripts/check-pr.js`) and the triage bot already do, and the PR carries labels: `ready`, `needs-v2`, `needs-metadata`, `needs-human`. Read them with `gh pr view <n> --json labels,statusCheckRollup`.
2. **V2 detection authority is `scripts/utils/compat.js`.** Run `node -e "require('./scripts/utils/compat').probeCompat([{key:'x',repo:'<url>',npm:'<pkg>',plugin:true}]).then(r=>console.log(r.get('x')))"` instead of reading package.json by hand. Pre-release V2 pins (`@opencode-ai/plugin@0.0.0-beta-*`, `@next`, `@opencode-ai/client`) are V2; `@opencode-ai/plugin@1.x` is V1.
3. **Only review PRs whose `validate` check is green** (or labeled `needs-human`, where you resolve the open question). A PR with no `validate` run can get one with `gh workflow run validate-pr.yml --ref <headRefName>`.
4. **Your verdict covers:** relevance to OpenCode, real utility (not a duplicate in spirit), safety/policy (zero tolerance for crypto/token/trading), and copy quality of `tagline`/`description`/`topics`.
5. **Inactivity is not a rejection reason.** Archived, deleted or npm-deprecated targets are; see `docs/policy.md`. The old "commits within 6 months" bar no longer applies.
6. **PRs with an `ai-approve`, `ai-fix`, `ai-close` or `ai-unsure` label already have an "AI review" comment** from the `ai-review.yml` workflow (verdict, reasons, and for `ai-fix` a schema-checked corrected entry). Start from it instead of re-reviewing from scratch; it is advisory, so confirm before acting.

## Merging Rules

- Merge with `gh pr merge <n> --squash` so the required check applies. **Never push catalog changes directly to `main`** and never "apply" a PR by committing its files separately; if a PR needs edits, push them to the PR branch.
- Before merging anything you edited, run `npm run validate && npm run generate` locally and confirm both exit 0.
- New entries must include `kind`, `topics` and (for plugins) `compat`; `npm run fmt` fixes formatting.
