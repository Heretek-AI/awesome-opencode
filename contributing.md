# Contribution Guidelines

Thank you for contributing to `awesome-opencode`! Every entry is a YAML file under `data/`; the README and the [search site](https://heretek-ai.github.io/awesome-opencode/) are generated from those files. **Never edit `README.md` directly**: PRs that do are rejected by the `validate` check.

## Option 1: the issue form (recommended)

[Open an "Add an entry" issue](https://github.com/Heretek-AI/awesome-opencode/issues/new?template=add-entry.yml). A bot validates the fields, checks OpenCode V2 compatibility for plugins, comments with the result, and opens the pull request for you. To fix something, edit the issue; the PR updates itself.

## Option 2: a pull request

1. Fork and clone the repo, then run `npm ci`.
2. Create the entry. The scaffolder writes a correctly formatted file and runs the V2 check:

   ```bash
   npm run new -- --category plugins --repo https://github.com/owner/repo \
     --tagline "Short summary" --topics memory,context [--npm package-name] [--path packages/x]
   ```

   Or write `data/<category>/<name>.yaml` by hand (kebab-case filename):

   ```yaml
   name: Quota Board
   repo: https://github.com/owner/opencode-quota-board
   npm: opencode-quota-board
   tagline: Provider quotas and reset countdowns in the OpenCode sidebar
   description: Adds quota bars, reset countdowns and credit balances to the OpenCode V2 TUI.
   kind: plugin
   topics:
     - cost
     - providers
   compat: v2
   ```

3. Run `npm run validate`, then open the PR. CI runs the same checks and comments with anything to fix.

## Fields

| Field | Required | Notes |
| :--- | :--- | :--- |
| `name` | yes | Max 80 characters |
| `repo` | yes | Repository **root** URL (GitHub, GitLab, Codeberg, Gitee; gists allowed). No `/tree/`, `/blob/`, npm pages or websites |
| `path` | no | Folder inside a monorepo, e.g. `packages/my-plugin` |
| `npm` | no | Package name; strongly recommended for plugins (used for the V2 check and health checks) |
| `tagline` | yes | Max 120 characters. Quote it if it contains `: ` (e.g. `tagline: "Plain: no jargon"`) |
| `description` | yes | Max 1500 characters |
| `kind` | yes | `plugin`, `theme`, `agent`, `skill`, `mcp-server`, `client`, `tool`, `config`, `guide` or `fork` |
| `topics` | yes | 1–3 of: memory, context, orchestration, workflow, providers, cost, notifications, sessions, code-quality, security, git, remote, web, ui, voice, media, docs, environment, observability, integrations, code-intel, prompting, domain. The first is used for README grouping |
| `compat` | plugins | `v2`, `v1` or `unknown`; CI verifies it. Other categories may omit it |
| `also` | no | Secondary kinds, e.g. `[mcp-server]` for a plugin that also ships an MCP server |
| `scope`, `tags`, `min_version`, `homepage`, `installation` | no | See [docs/schema-design.md](docs/schema-design.md) |

Unknown fields are rejected, so typos like `repository:` or `install:` are caught.

Which category? `plugins` for OpenCode plugin packages, `themes` for color themes, `agents` for agent configs and skill packs, `projects` for clients, GUIs, MCP servers, tools and forks, `resources` for guides, configs and starters.

## What gets accepted

See the [catalog policy](docs/policy.md). In short:

- **Relevant**: works with OpenCode.
- **Public**: the repository is public and not archived.
- **V2 for new plugins**: depends on `@opencode/plugin` and uses `Plugin.define`. V1 plugin PRs are held with the `needs-v2` label; a nightly job re-checks them and unblocks the PR automatically once the plugin migrates.
- **Unique**: one entry per repository (per `path` for monorepos).
- **No crypto**: no cryptocurrency, token or trading projects.

## What happens after you submit

1. **`validate` check**: schema, duplicates, generated-file edits and the V2 check. Required to merge.
2. **Triage**: a bot labels the PR (`ready`, `needs-v2`, `needs-metadata` or `needs-human`) and comments with the results.
3. **Maintainer review and merge.**
4. **README, registry and search site regenerate automatically.**
