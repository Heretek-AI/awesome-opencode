# Examples

This directory contains exemplar YAML files showing the full schema for each extension type.

**These are reference examples, not actual entries.**

## Usage

When adding a new entry to `data/{category}/`, use the corresponding example as a reference:

| Adding to... | Reference |
|-------------|-----------|
| `data/plugins/` | [plugin.yaml](plugin.yaml) |
| `data/themes/` | [theme.yaml](theme.yaml) |
| `data/agents/` | [agent.yaml](agent.yaml) |
| `data/projects/` | [project.yaml](project.yaml) |
| `data/resources/` | [resource.yaml](resource.yaml) |
| `data/projects/` (`kind: fork`) | [fork.yaml](fork.yaml) |

## Required vs Optional Fields

### Required (all entries must have)
- `name` - Display name
- `repo` - Repository URL (https://github.com/...)
- `tagline` - Short description (max 120 chars)
- `description` - Full description (can be multi-line)

### Optional (include if relevant)
- `scope` - Installation scope: `[global]`, `[project]`, or `[global, project]` (defaults to `[global]`)
- `tags` - Array of strings for filtering
- `min_version` - Minimum OpenCode version (semver)
- `homepage` - Documentation URL if different from repo
- `installation` - Markdown installation instructions

## Notes

- **Type is derived from directory** - No `type` field needed; it's inferred from the folder
- **Scope is optional** - Defaults to `[global]`; add if project-level install is relevant
- **Installation is markdown** - Use headers, code blocks, lists as needed
- **Schema allows additional fields** - Future fields can be added without breaking existing entries
