# Catalog Policy

How entries get into the catalog, how they are kept honest, and when they leave. Automation enforces most of this; this page is the reference it links to.

## Admission

An entry must:

- work with OpenCode;
- point at a public, non-archived repository root (`path` for a monorepo folder);
- be the only entry for that repository and path;
- not be a cryptocurrency, token or trading project (zero tolerance);
- pass `npm run validate` (schema, field limits, kind/category fit).

### OpenCode V2 requirement for new plugins

New entries in `data/plugins/` must use the V2 plugin API: depend on an `@opencode/*` package (normally `@opencode/plugin`) and export `Plugin.define({ id, setup(ctx) })`. Pre-release V2 builds published under the old name (`@opencode-ai/plugin@0.0.0-beta-*`, `@next`, `@beta`, or `@opencode-ai/client`) also count. Packages that ship both V1 and V2 entry points count as V2.

The `validate` check detects this from, in order: the entry's `npm` package, `package.json` files in the repository (at `path`, the root and `packages/*` / `plugins/*`), then the source code. Results:

| Detected | New plugin PR | Meaning |
| :--- | :--- | :--- |
| `v2` | passes | `@opencode/*` dependency or `Plugin.define` found |
| `v1` | blocked, labeled `needs-v2` | Only `@opencode-ai/plugin`/`sdk` 1.x, or a legacy V1 plugin function without `Plugin.define` |
| `unknown` | passes with `needs-human` | Nothing conclusive found; a maintainer verifies by hand. Adding `npm` or `path` usually resolves it |

PRs labeled `needs-v2` are re-checked every night. When the target migrates, the bot relabels the PR, fills in any missing fields on same-repo branches, re-runs `validate` and tells the author. **After 60 days still on V1, the PR is closed**; reopen it or resubmit through the issue form after migrating.

Themes, agents, projects and resources are not blocked on V2. Their `compat` is informational (`v2`/`v1` when they use the SDK, otherwise `n/a`).

## Existing V1 plugins: sunset on 2027-01-01

Plugins already in the catalog that are V1-only carry a `V1 only` badge in the README and on the site. **After 2027-01-01 they are removed** by the nightly health job's removal PR unless they have migrated (the check runs again before removal). Plugins with `unknown` compatibility are listed in the health report for manual verification before that date.

## Health checks and removal

A nightly job checks every entry and maintains the **Catalog health report** issue.

| Finding | Action |
| :--- | :--- |
| Repository renamed or transferred | Bot PR updates the `repo` URL |
| Repository archived, deleted (404), or npm package deprecated | Listed in the report; **removal PR after 30 days** if it doesn't recover |
| V1-only plugin after 2027-01-01 | Removal PR |
| No push for 6–12 months / 12+ months | `quiet` / `stale` badge on the site. **Never removed for inactivity alone**: small, finished tools are fine |

Removal PRs are reviewed like any other PR; closing one keeps the entries until the next run proposes them again. Git history is the archive; there is no separate retired list.

## Discovery

A weekly scout searches npm for packages published since V2 shipped that depend on `@opencode/*`, keeps public, licensed, non-archived, non-fork repositories that are not already listed or in an open PR, and ranks them by weekly downloads, then stars. It posts a **Scout** issue; a maintainer ticking a candidate's box makes the bot open a PR for it. Add a package or repo to [`discovery/declined.txt`](../discovery/declined.txt) to stop suggesting it.

## Branch protection

`main` has a ruleset: every commit that lands on it must have a passing `validate` check, and force-pushes and deletion are blocked. Contributors and maintainers get the check through pull requests; bots get it by dispatching `validate` on their branch. Repository admins can merge a PR whose check is failing or pending (for a broken CI), but cannot push unvalidated commits directly.

## Automation map

| Workflow | When | What |
| :--- | :--- | :--- |
| `validate-pr.yml` | every PR | Required `validate` check |
| `triage.yml` | PR opened/updated | Labels and a results comment (base-branch code only) |
| `generate-readme.yml` | push to main | README.md and dist/registry.json; fails without writing on any invalid entry. The regenerated commit is staged on `bot/readme-*`, validated, then fast-forwarded onto main |
| `site.yml` | push to main, daily | Search site on GitHub Pages |
| `health.yml` | daily | Health report issue, rename and removal PRs |
| `reprobe.yml` | daily | Re-checks `needs-v2` PRs |
| `scout.yml` | weekly | Scout issue with V2 plugin candidates |
| `issues.yml` | issue opened/edited | Issue-form submissions and scout acceptances become PRs |
