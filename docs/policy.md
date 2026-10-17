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

Plugins already in the catalog that are V1-only carry a `V1 only` badge in the README and on the site. The nightly health job re-detects every plugin not marked `v2`; when one is detected as V2 it opens a PR (`bot/health-compat`) marking the entry `compat: v2`. **After 2027-01-01 V1-only plugins are removed** by the health job's removal PR, but only when that night's re-check still detects V1: a V2 or inconclusive result keeps the entry, and inconclusive ones are listed in the health report for a maintainer. Plugins with `unknown` compatibility are listed there too for manual verification.

The bot keeps the list in the V1 sunset tracking issue (label `v1-sunset`) current, posts one reminder there 31 days before the sunset, and closes the issue once no V1-only plugins remain.

## Health checks and removal

A nightly job checks every entry and maintains the **Catalog health report** issue.

| Finding | Action |
| :--- | :--- |
| Repository renamed or transferred | Bot PR updates the `repo` URL |
| Repository archived, deleted (404), or npm package deprecated | Listed in the report; **removal PR after 30 days** if it doesn't recover |
| Plugin not marked `v2` now detected as V2 | Bot PR sets `compat: v2` |
| V1-only plugin after 2027-01-01, still detected as V1 | Removal PR |
| No push for 6–12 months / 12+ months | `quiet` / `stale` badge on the site. **Never removed for inactivity alone**: small, finished tools are fine |

Removal PRs are reviewed like any other PR; closing one keeps the entries until the next run proposes them again. Git history is the archive; there is no separate retired list.

## Discovery

A weekly scout searches npm for packages published since V2 shipped that depend on `@opencode/*`, keeps public, licensed, non-archived, non-fork repositories that are not already listed or in an open PR, and ranks them by weekly downloads, then stars. It posts a **Scout** issue; a maintainer ticking a candidate's box makes the bot open a PR for it. Add a package or repo to [`discovery/declined.txt`](../discovery/declined.txt) to stop suggesting it.

## Branch protection

`main` has a ruleset: changes land only through pull requests with a passing `validate` check (GitHub rulesets do not accept direct pushes while a status check is required), and force-pushes and deletion are blocked. Bots open PRs too; GitHub holds workflow runs on bot-opened PRs for approval, so each bot approves the `validate` run on its own PR. Repository admins can merge a PR whose check is failing or pending (for a broken CI).

## Automation map

| Workflow | When | What |
| :--- | :--- | :--- |
| `validate-pr.yml` | every PR | Required `validate` check |
| `triage.yml` | PR opened/updated | Labels and a results comment (base-branch code only). `needs-human` is only ever removed by a maintainer |
| `generate-readme.yml` | push to main | README.md and dist/registry.json; fails without writing on any invalid entry. The regenerated commit goes through a bot PR (`bot/readme-*`) that merges itself once `validate` passes |
| `site.yml` | push to main, daily | Search site on GitHub Pages |
| `health.yml` | daily | Health report and V1 sunset issues; rename, V2-migration and removal PRs |
| `reprobe.yml` | daily | Re-checks `needs-v2` PRs |
| `scout.yml` | weekly | Scout issue with V2 plugin candidates |
| `issues.yml` | issue opened/edited | Issue-form submissions and scout acceptances become PRs |
