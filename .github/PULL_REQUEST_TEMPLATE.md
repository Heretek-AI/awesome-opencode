<!--
Easiest path: use the "Add an entry" issue form instead of a PR. A bot writes the YAML and opens the PR for you:
https://github.com/Heretek-AI/awesome-opencode/issues/new?template=add-entry.yml

Editing by hand? Add data/<category>/<name>.yaml (see contributing.md). Do not edit README.md; it is generated.
`npm run new -- --category plugins --repo <url> --tagline "..." --topics memory` writes a valid file for you.
-->

## What does this add or change?

<!-- One or two sentences. -->

## Plugins only: OpenCode V2

- [ ] The plugin depends on `@opencode/plugin` (not the legacy `@opencode-ai/plugin` 1.x) and exports `Plugin.define({ id, setup(ctx) })`.

New V1 plugins are not accepted. The `validate` check verifies this automatically and explains anything it can't confirm. See [docs/policy.md](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md).
