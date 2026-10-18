# Backlog Review — Issue #15: Add dreampowers

## Executive Summary

Issue #15 ([upstream awesome-opencode#241]) proposes adding **dreampowers** (https://github.com/skyfiredao/dreampowers), a complete AI skill set for Chinese novel writing, to the awesome-opencode catalog.

**Verdict: `ISSUE_CONVERT_TO_PR`** — the listing is high quality, actively maintained, safe (no crypto/Web3/malware), not a duplicate, and compatible with OpenCode V2. The next step is to have the author (or a maintainer) create the catalog entry `data/agents/dreampowers.yaml` conforming to `data/schema.json`.

## Findings

| Criterion | Result |
|---|---|
| Repo state | Public, not archived, GPL-3.0, 73★ / 7 forks |
| Maintenance | Active — latest commit `dw: 优化` on **2026-07-02**; prior commits Apr 2026. Within 6-month window; not abandoned |
| OpenCode V2 compatibility | **V2_COMPATIBLE** — ships `dp-*` skills as `SKILL.md` prompt files installed via `install.sh` symlinks into `~/.config/opencode/skills/`, which is OpenCode V2's native skills directory. No legacy `@opencode-ai/plugin` / `Plugin.define` (it is a skills/prompts package, not a daemon plugin). Coexists with coding skill sets (e.g. Superpowers) via `dp-` prefix + entry switching |
| Safety / policy | Pass — Chinese fiction-writing skill set; no cryptocurrency/tokens/Web3 trading bots, no credential scrapers, no obfuscated payloads (opt-in adult scene writing is creative fiction, none of the prohibited categories) |
| Uniqueness | Pass — no existing `dreampowers` entry in `data/` (grep returned no matches); not a fork of a listed entry |
| Catalog fit | `data/agents/` (OpenCode V2 skills / agent-skill configuration) |
| YAML present in issue | None — a conforming `data/agents/dreampowers.yaml` must be authored |

## Suggested catalog entry (`data/agents/dreampowers.yaml`)

```yaml
name: Dreampowers
repo: https://github.com/skyfiredao/dreampowers
tagline: Complete AI skill set for Chinese novel writing with 14 specialized fiction-craft skills
description: Dreampowers is a complete AI skill set for Chinese novel writing built on OpenCode V2's skills system. It provides 14 specialized skills (13 default + 1 opt-in) covering every stage of fiction creation—from story ideation to manuscript completion—with innovations in preventing worldbuilding info-dumps (Six Iron Rules), reader-perspective testing, AI-flavor detection and elimination, three-stage chapter review, foreshadowing tracking, and concept isolation. Skills (dp-*) install as OpenCode V2 skills via symlinks to ~/.config/opencode/skills/ and coexist with coding skill sets such as Superpowers.
scope:
  - global
tags:
  - skills
  - chinese
  - novel-writing
  - fiction
  - creative-writing
min_version: "2.0.0"
installation: |
  Clone the repository and run `./install.sh` to symlink the `dp-*` skills to `~/.config/opencode/skills/`. Use `./install.sh --all` to include opt-in skills (e.g. `dp-chapter-adult`). Activate in an OpenCode session with `Use skill dp-using-dreampowers`.
```

## Recommended comment to leave on the issue

> Thank you for the submission! Dreampowers is a well-maintained, OpenCode V2–native skill set (installs `dp-*` SKILL.md skills into `~/.config/opencode/skills/`) and meets the awesome-opencode quality bar. We'd welcome a catalog entry — please open a PR adding `data/agents/dreampowers.yaml` conforming to `data/schema.json` (suggested fields above). Once the YAML is in place, this is good to merge.
