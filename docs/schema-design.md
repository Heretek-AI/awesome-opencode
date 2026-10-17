# OpenCode Extension Schema Design

This document describes the YAML schema for the awesome-opencode registry, a data-driven catalog of OpenCode extensions. It covers extension types, configuration locations, schema fields, and downstream compatibility.

---

## 1. Overview

The awesome-opencode registry is a curated collection of extensions that enhance the OpenCode editor. The registry follows a data-driven approach where YAML files in `data/{category}/` directories serve as the source of truth.

### Design Principles

- **Human Readable**: YAML format ensures contributors can easily read and edit entries
- **Downstream Ready**: Schema designed for seamless consumption by platforms like opencode.cafe
- **Discoverable**: Tags and metadata support filtering and search
- **Extensible**: Schema allows additional fields for future enhancements
- **Type by Location**: Extension type is derived from directory, not stored in YAML

### Directory Structure

```
awesome-opencode/
├── data/
│   ├── plugins/
│   │   └── *.yaml
│   ├── themes/
│   │   └── *.yaml
│   ├── agents/
│   │   └── *.yaml       # Agent configurations and skills
│   ├── projects/
│   │   └── *.yaml
│   ├── resources/
│   │   └── *.yaml       # Guides, configs, MCP servers, tools, commands
│   └── examples/
│       └── *.yaml       # Exemplar files showing all fields
└── docs/
    └── schema-design.md
```

---

## 2. OpenCode Extension Types

Extensions in awesome-opencode fall into distinct categories, each serving a specific purpose in the OpenCode ecosystem.

### 2.1 Plugin (`plugin`)

JavaScript or TypeScript modules that extend OpenCode's core functionality. Plugins can be installed via npm or as local files.

**Installation Methods:**
- NPM package: `npm install <plugin-name>`
- Local path: Reference to local `.js` or `.ts` file

**Example Use Cases:**
- Authentication providers
- Custom UI components and panels
- Integration with external services

### 2.2 Theme (`theme`)

Visual themes that customize the OpenCode editor appearance. Themes are distributed as JSON files containing color schemes and styling rules.

**Installation Methods:**
- JSON file placed in themes directory
- Referenced from remote URL

**Example Use Cases:**
- Dark/light mode variations
- Syntax highlighting for specific languages
- Custom UI color schemes

### 2.3 Agent (`agent`)

Custom AI agent configurations and skills that define behavior, tools, and instructions for specialized tasks. This category includes both agent configurations and reusable skill instruction sets.

**Includes:**
- Agent configurations (system prompts, available tools, behavior)
- Skills (reusable instruction sets in `SKILL.md` format)

**Example Use Cases:**
- Security-focused code reviewers
- Documentation generators
- Interview question generators
- Bug reproduction assistants

### 2.4 Project (`project`)

Standalone applications, utilities, and tools built for or with OpenCode. These are complete projects rather than extensions.

**Example Use Cases:**
- Web interfaces for OpenCode
- Session management tools
- Proxy servers and API wrappers
- Companion applications

### 2.5 Resource (`resource`)

Guides, configurations, MCP servers, tools, and commands that enhance the OpenCode experience without being installable plugins.

**Includes:**
- Configuration starters and examples
- MCP servers (Model Context Protocol servers)
- CLI tools and utilities
- Custom slash commands
- How-to guides and tutorials

**Example Use Cases:**
- Database access MCP servers
- API integrations (GitHub, Slack, etc.)
- Project-specific build commands
- Starter configuration templates

### 2.6 Fork (`fork`)

Modified builds of OpenCode itself with custom features or patches. Forks maintain compatibility while adding functionality. They live in `data/projects/` with `kind: fork`.

**Example Use Cases:**
- Custom builds with enterprise features
- Experimental feature branches
- Distribution-specific variants

---

## 3. OpenCode Configuration Locations

OpenCode extensions can be installed in multiple locations depending on their scope and purpose. Understanding these locations is crucial for proper installation and management.

### 3.1 Global Configuration (User-Wide)

Global installations apply to all projects for the current user.

| Path | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | Main configuration file |
| `~/.config/opencode/plugin/` | Plugin modules |
| `~/.config/opencode/themes/` | Theme JSON files |
| `~/.config/opencode/command/` | Custom slash commands |
| `~/.config/opencode/agent/` | Custom agent configurations |
| `~/.config/opencode/skill/<name>/SKILL.md` | Global skills |

**Note:** On Windows, the equivalent is `%APPDATA%/opencode/`.

### 3.2 Project-Level Configuration

Project-level installations are scoped to specific repositories.

| Path | Purpose |
|------|---------|
| `<project>/opencode.json` | Project-specific configuration |
| `<project>/.opencode/plugin/` | Project plugins |
| `<project>/.opencode/themes/` | Project themes |
| `<project>/.opencode/command/` | Project commands |
| `<project>/.opencode/agent/` | Project agents |
| `<project>/.opencode/skill/<name>/SKILL.md` | Project skills |

### 3.3 Claude-Compatible Paths

OpenCode maintains compatibility with Claude's skill system for portability.

| Path | Purpose |
|------|---------|
| `~/.claude/skills/<name>/SKILL.md` | Global Claude skills |
| `.claude/skills/<name>/SKILL.md` | Project Claude skills |

### 3.4 Remote and Custom Configurations

Extensions can also be fetched from remote sources or custom locations.

| Path/Variable | Purpose |
|---------------|---------|
| `.well-known/opencode` | Organizational defaults fetched remotely |
| `OPENCODE_CONFIG` | Environment variable pointing to custom config file |
| `OPENCODE_CONFIG_DIR` | Environment variable pointing to custom config directory |

### 3.5 Precedence Order

When multiple configuration sources exist, OpenCode follows this precedence (later sources override earlier ones):

```
1. Remote config (.well-known/opencode)
2. Global config (~/.config/opencode/)
3. Custom config (OPENCODE_CONFIG env var)
4. Project config (opencode.json)
5. Project local directories (.opencode/)
6. Inline config (environment variables)
```

**Resolution Example:**
If `scope` is set to `[global, project]` and both global and project configs define the same extension, the project-level configuration takes precedence for that project.

---

## 4. YAML Schema

`data/schema.json` defines the fields; `scripts/utils/catalog.js` adds rules that need the whole catalog (one entry per repository and `path`, `kind` must fit the category directory, `compat` required for plugins, no placeholder repo owners, no mis-encoded text). Unknown fields are rejected (`additionalProperties: false`).

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name, max 80 characters |
| `repo` | string | Repository root URL on GitHub, GitLab, Codeberg or Gitee (gists and GitHub discussions also accepted). No `/tree/` or `/blob/` paths, npm pages or websites |
| `tagline` | string | Short summary, max 120 characters |
| `description` | string | Full description, max 1500 characters |
| `kind` | enum | `plugin`, `theme`, `agent`, `skill`, `mcp-server`, `client`, `tool`, `config`, `guide`, `fork` |
| `topics` | array | 1–3 of the fixed topic list (see `data/schema.json`); the first is the primary topic used for README grouping |
| `compat` | enum | Required for `data/plugins/` only: `v2`, `v1` or `unknown` (verified by CI). Other categories: optional, `v2`/`v1` when they use the SDK, otherwise `n/a` |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | - | Folder inside a monorepo, e.g. `packages/my-plugin` |
| `npm` | string | - | npm package name; used for the V2 check, health checks and the npm link |
| `also` | array | - | Secondary kinds (e.g. `[mcp-server]`), cross-listed on the site |
| `scope` | array | `[global]` | Installation scope: `[global]`, `[project]`, or `[global, project]` |
| `tags` | array | `[]` | Free-form search keywords (not rendered; use `topics` for categorization) |
| `min_version` | string | - | Minimum OpenCode version required (semver, e.g., `"2.0.0"`) |
| `homepage` | string | - | Documentation URL if different from repository |
| `installation` | string | - | Detailed installation instructions (markdown format) |

### Kind per Category

The directory is the coarse bucket (and the `type` downstream consumers see); `kind` says what the entry actually is.

| Directory | Allowed `kind` |
|-----------|----------------|
| `data/plugins/` | `plugin` |
| `data/themes/` | `theme` |
| `data/agents/` | `agent`, `skill` |
| `data/projects/` | `client`, `tool`, `mcp-server`, `skill`, `agent`, `fork` |
| `data/resources/` | `guide`, `config`, `mcp-server`, `skill`, `tool` |

### Minimal Valid Entry

```yaml
name: My Extension
repo: https://github.com/user/my-extension
tagline: A brief description of what this does
description: A longer explanation of the extension.
kind: plugin
topics:
  - workflow
compat: v2
```

### Complete Entry (All Fields)

```yaml
name: My Extension
repo: https://github.com/user/my-monorepo
path: packages/my-extension
npm: opencode-my-extension
homepage: https://example.com/docs
tagline: "A brief tagline: quote it when it contains a colon"
description: |
  A longer description explaining
  the extension in detail.
kind: plugin
also:
  - mcp-server
topics:
  - memory
  - context
compat: v2
scope:
  - global
  - project
tags:
  - productivity
min_version: "2.0.0"
installation: |
  Add `opencode-my-extension` to the `plugin` list in `opencode.json`.
```

Use `npm run new` to scaffold an entry and `npm run fmt` to rewrite entries in canonical key order with safe quoting.

### Examples Directory

Full exemplar files for each extension type are available in `data/examples/`:

| Type | Example File |
|------|-------------|
| Plugin | `data/examples/plugin.yaml` |
| Theme | `data/examples/theme.yaml` |
| Agent | `data/examples/agent.yaml` |
| Project | `data/examples/project.yaml` |
| Resource | `data/examples/resource.yaml` |
| Fork | `data/examples/fork.yaml` (forks now live in `data/projects/` with `kind: fork`) |

---

## 5. Installation Template

The `installation` field uses a structured template that contributors fill in. Not all sections are required—include what's relevant for the extension.

### Template Structure

```markdown
## Prerequisites
- OpenCode version requirements
- Other dependencies (Node.js, Python, CLI tools, etc.)

## Installation

### Global (all projects)
Steps for installing to ~/.config/opencode/

### Project-only
Steps for installing to .opencode/ within a project

## Configuration
Config options to add to opencode.json

## Files Modified
List of files created/modified (for backup purposes)
- ~/.config/opencode/opencode.json
- ~/.config/opencode/plugin/codegpt.js

## Removal
How to uninstall the extension
```

### Template Guidelines

1. **Prerequisites**: List minimum versions and dependencies
2. **Installation**: Provide both global and project-specific instructions if `scope` includes both
3. **Configuration**: Show exact JSON/config snippets needed
4. **Files Modified**: Help users understand what will change for backup/restore
5. **Removal**: Include cleanup steps for uninstallation

### Section Requirements by Type

| Extension Type | Key Sections |
|----------------|--------------|
| `plugin` | Installation, Configuration |
| `theme` | Installation, Files Modified |
| `agent` | Installation, Configuration |
| `project` | Prerequisites, Installation |
| `resource` | Prerequisites, Installation, Configuration |
| `fork` | Installation, Files Modified |

---

## 6. Downstream Compatibility

The awesome-opencode schema is designed for seamless conversion to downstream platforms like opencode.cafe.

### Field Mapping

| awesome-opencode YAML | opencode.cafe JSON | Notes |
|-----------------------|-------------------|-------|
| `name` | `displayName` | Display name for UI |
| `repo` | `repoUrl` | Repository URL |
| `tagline` | `tagline` | Short summary |
| `description` | `description` | Full description |
| (directory) | `type` | Derived from directory path |
| (filename) | `productId` | Derived from filename |
| `scope` | `scope` | Defaults to `["global"]` |
| `tags` | `tags` | Array of strings |
| `homepage` | `homepageUrl` | Documentation URL |
| `installation` | `installation` | Markdown content |
| `min_version` | `minVersion` | Semver string |
| `path` | `repoPath` | Monorepo folder (added 2026-10) |
| `npm` | `npmPackage` | npm package name (added 2026-10) |
| `kind` | `kind` | What the entry is (added 2026-10) |
| `also` | `also` | Secondary kinds (added 2026-10) |
| `topics` | `topics` | Use-case topics (added 2026-10) |
| `compat` | `compat` | `v2`, `v1`, `unknown` or `n/a`; plugins default to `unknown` (added 2026-10) |

### Conversion Example

**YAML Input (`data/plugins/codegpt.yaml`):**

```yaml
name: CodeGPT
repo: https://github.com/company/codegpt
tagline: AI-powered code completion
description: Intelligent code completion using GPT models.
```

**JSON Output (opencode.cafe format):**

```json
{
  "productId": "codegpt",
  "type": "plugin",
  "displayName": "CodeGPT",
  "repoUrl": "https://github.com/company/codegpt",
  "tagline": "AI-powered code completion",
  "description": "Intelligent code completion using GPT models.",
  "scope": ["global"],
  "tags": []
}
```

Note: `type` is derived from `data/plugins/` → `plugin`, and `productId` from filename `codegpt.yaml` → `codegpt`.

---

## 7. Future Vision

This section outlines planned features and improvements for the awesome-opencode ecosystem.

### 7.1 Agent-Powered Plugin Manager

A future plugin/agent that uses the `installation` markdown as context to assist with setup. The agent would:
- Parse the installation instructions
- Know which files will be modified (for backup purposes)
- Guide users through the installation interactively
- Handle scope selection based on user preference

This is **not** an automated CLI executor - it's an AI assistant with context about how to install the extension.

### 7.2 Interactive TUI with Scope Selection

A terminal UI that:
- Reads the `scope` field to present appropriate options
- Shows extension metadata and readme preview
- Handles multi-step installations interactively

```
┌─────────────────────────────────────────┐
│  Install Extension                      │
├─────────────────────────────────────────┤
│  Name:     CodeGPT                      │
│  Type:     plugin                       │
│  Scope:    [X] Global  [ ] Project      │
│                                         │
│  [Install]  [Cancel]  [View Readme]     │
└─────────────────────────────────────────┘
```

### 7.3 Automatic Backup and Restore

When an agent assists with installation, it can:
- Read the "Files Modified" section to know what to backup
- Store backups before making changes
- Enable clean removal with rollback capability

### 7.4 Contributing Workflow Improvements

Future improvements to the contribution process:

Implemented in 2026-10; see [policy.md](policy.md#automation-map):

1. **Schema Validation**: the required `validate` check runs on every PR
2. **V2 Compatibility Check**: plugins are probed for `@opencode/*` and `Plugin.define`
3. **Link Checking**: the nightly health job tracks renamed, archived, missing and deprecated targets

---

## 8. Quick Reference

### Extension Type to Directory Mapping

| Type | Directory |
|------|-----------|
| `plugin` | `data/plugins/` |
| `theme` | `data/themes/` |
| `agent` | `data/agents/` |
| `project` | `data/projects/` |
| `resource` | `data/resources/` |

Forks are entries in `data/projects/` with `kind: fork`; see "Kind per Category" in section 4.

### Minimal Valid Entry

```yaml
name: My Extension
repo: https://github.com/user/my-extension
tagline: A brief description
description: A longer explanation of what this extension does.
```

### Complete Entry (All Fields)

See `data/examples/` directory for full exemplar files.

```yaml
name: My Extension
repo: https://github.com/user/my-extension
tagline: A brief tagline (max 120 chars)
description: |
  A longer description explaining
  the extension in detail.
scope:
  - global
  - project
tags:
  - productivity
  - ai
min_version: "1.0.0"
homepage: https://example.com/docs
installation: |
  ## Installation
  ```bash
  git clone https://github.com/user/my-extension ~/.config/opencode/plugin/my-extension
  ```
```

### Commands

```bash
npm run validate   # schema and catalog rules for every entry
npm run generate   # regenerate README.md
npm run new -- --category plugins --repo <url> --tagline "..." --topics memory
npm run fmt        # canonical formatting for all entries
```

---

## 9. Status

The contributing guide, README enhancements (topic/kind grouping, V1/V2 badges, counts, recently added) and the JSON export described in earlier versions of this document are implemented. Catalog rules are in [policy.md](policy.md).

---

*Document Version: 2.0*
*Last Updated: 2026-10-17*
