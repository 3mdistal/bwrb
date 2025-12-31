# Neovim Plugin for ovault

> Native Neovim integration with full CLI feature parity

**Beads Issue:** `ovault-tic`

---

## Overview

A Neovim plugin (`ovault.nvim`) that brings the full power of ovault into the editor. The goal is **feature parity with the CLI** for human-usable operations, making Neovim a complete PKM (Personal Knowledge Management) environment.

```
┌─────────────────────────────────────────────────────────┐
│                      Neovim                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Telescope  │  │  Floating   │  │  Diagnostics    │  │
│  │  Pickers    │  │  Windows    │  │  Integration    │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    ovault.nvim                           │
│  • CLI wrapper (--json mode)                            │
│  • Native Lua for hot paths                             │
│  • UI component library                                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    ovault CLI                            │
│  • JSON mode for all commands                           │
│  • Single source of truth for logic                     │
└─────────────────────────────────────────────────────────┘
```

---

## Architecture Decision: Hybrid Approach

**Why not pure Lua?**
- Duplicates 4000+ lines of TypeScript logic
- Divergence risk between CLI and plugin
- Schema parsing, validation, query expressions are complex

**Why not thin CLI wrapper only?**
- Startup latency for simple operations
- Less native feel
- Can't leverage Neovim APIs directly

**Hybrid approach:**
- **CLI with `--json`** for complex operations (new, edit, audit, bulk)
- **Native Lua** for hot paths (search picker, list display, wikilink completion)
- **Shared schema understanding** via parsed JSON from `ovault schema show --output json`

---

## Command Mapping

| CLI Command | Neovim Command | Implementation |
|-------------|----------------|----------------|
| `ovault new [type]` | `:OvaultNew [type]` | CLI + floating inputs |
| `ovault edit <file>` | `:OvaultEdit` | CLI + floating inputs |
| `ovault list <type>` | `:OvaultList <type>` | CLI + buffer/Telescope |
| `ovault search <query>` | `:OvaultSearch` | CLI + Telescope |
| `ovault open <file>` | `:OvaultOpen` | Native `:edit` |
| `ovault audit` | `:OvaultAudit` | CLI + diagnostics |
| `ovault bulk` | `:OvaultBulk` | CLI + preview buffer |
| `ovault schema show` | `:OvaultSchema` | CLI + floating window |
| `ovault template list` | `:OvaultTemplates` | CLI + Telescope |

---

## Phase 1: Foundation (Weeks 1-3)

### 1.1 Core Infrastructure

```lua
-- lua/ovault/init.lua
local M = {}

M.setup = function(opts)
  -- Vault detection (find .ovault/schema.json)
  -- CLI path configuration
  -- Keybinding setup
end

return M
```

**Deliverables:**
- [ ] Plugin structure with lazy.nvim/packer support
- [ ] Vault detection (walk up to find `.ovault/`)
- [ ] CLI wrapper module (`lua/ovault/cli.lua`)
- [ ] JSON response parser
- [ ] Error handling with `vim.notify`

### 1.2 Basic Commands

**`:OvaultOpen [query]`** — Open note by name
- Uses `ovault search --json` for resolution
- Falls back to Telescope if ambiguous
- Direct `:edit` for exact match

**`:OvaultList <type>`** — List notes in buffer
- Calls `ovault list <type> --output json`
- Renders in scratch buffer or quickfix
- Supports `--where` expressions

**`:OvaultSchema`** — Show schema tree
- Calls `ovault schema show`
- Floating window with type hierarchy

### 1.3 Telescope Integration

```lua
-- lua/telescope/_extensions/ovault.lua
return require("telescope").register_extension({
  exports = {
    search = require("ovault.telescope.search"),
    list = require("ovault.telescope.list"),
    types = require("ovault.telescope.types"),
  },
})
```

**Pickers:**
- `Telescope ovault search` — Note search with wikilink output
- `Telescope ovault list` — Filtered list with type selection
- `Telescope ovault types` — Type hierarchy navigation

---

## Phase 2: Interactive Commands (Weeks 4-7)

### 2.1 Floating Input Windows

Custom UI for schema-driven prompts:

```lua
-- lua/ovault/ui/input.lua
local M = {}

-- Single line input with validation
M.input = function(opts)
  -- opts: { prompt, default, validate, on_submit }
end

-- Selection from options (like promptSelection)
M.select = function(opts)
  -- opts: { prompt, items, on_select }
  -- Supports number keys for quick selection
end

-- Multi-line input (for multi-input fields)
M.multi_input = function(opts)
  -- opts: { prompt, on_submit }
end

return M
```

### 2.2 `:OvaultNew [type]`

Interactive note creation:

1. If no type, show type picker (Telescope or floating select)
2. Navigate subtypes if needed
3. Prompt for template if multiple available
4. Show floating inputs for each field (respecting schema order)
5. Call `ovault new <type> --json '{...}'`
6. Open created file

**Flow diagram:**
```
:OvaultNew
    │
    ├─► Type picker (Telescope)
    │       │
    │       ▼
    ├─► Subtype picker (if has subtypes)
    │       │
    │       ▼
    ├─► Template picker (if multiple)
    │       │
    │       ▼
    ├─► Field prompts (floating windows)
    │   ├── Name (required)
    │   ├── Status (select from enum)
    │   ├── Priority (select)
    │   └── ... (dynamic fields)
    │       │
    │       ▼
    └─► ovault new --json → :edit <path>
```

### 2.3 `:OvaultEdit`

Edit frontmatter of current buffer:

1. Detect type from frontmatter
2. Show current values with edit prompts
3. Call `ovault edit <path> --json '{...}'`
4. Refresh buffer

---

## Phase 3: Advanced Features (Weeks 8-10)

### 3.1 `:OvaultAudit` with Diagnostics

```lua
-- Register diagnostic namespace
local ns = vim.diagnostic.get_namespace("ovault")

-- Run audit and populate diagnostics
M.audit = function()
  local results = cli.run("audit", { "--output", "json" })
  for _, file_result in ipairs(results.files) do
    local diagnostics = {}
    for _, issue in ipairs(file_result.issues) do
      table.insert(diagnostics, {
        lnum = 0, -- Frontmatter is at top
        col = 0,
        severity = issue.severity == "error" 
          and vim.diagnostic.severity.ERROR
          or vim.diagnostic.severity.WARN,
        message = issue.message,
        source = "ovault",
      })
    end
    vim.diagnostic.set(ns, bufnr, diagnostics)
  end
end
```

**Features:**
- Populate `vim.diagnostic` for all open buffers
- Quickfix list with all issues
- `:OvaultAuditFix` for interactive fixing

### 3.2 `:OvaultBulk`

Bulk operations with preview:

1. Show matching files in preview buffer
2. Display proposed changes
3. Confirm before execution
4. Call `ovault bulk --execute`

### 3.3 Wikilink Completion

```lua
-- lua/ovault/completion.lua
-- Integrates with nvim-cmp or built-in completion

-- Trigger on [[ 
-- Call ovault search --json with prefix
-- Return completion items with wikilink format
```

---

## Phase 4: Polish & Ecosystem (Weeks 11-13)

### 4.1 Dashboard Integration

Saved queries (linked issue: `ovault-48g`):

```lua
:OvaultDashboard           -- Show saved query list
:OvaultDashboardSave       -- Save current list query
:OvaultDashboardRun <name> -- Run saved query
```

### 4.2 Formatted Table Output

Better list display (linked issue: `ovault-hvf`):

- Aligned columns in buffer
- Sortable headers
- Click-to-open

### 4.3 Wikilink Insertion Picker

Fuzzy finder for links (linked issue: `ovault-ng6`):

```lua
:OvaultLink           -- Insert [[wikilink]] at cursor
:OvaultLinkVisual     -- Wrap selection in [[]]
```

### 4.4 Status Line Integration

```lua
-- For lualine, etc.
require("ovault").statusline()
-- Returns: "ovault: Tasks (12 active)"
```

---

## Testing Strategy

### Unit Tests (Pure Lua)

```
tests/
├── unit/
│   ├── cli_spec.lua        -- JSON parsing, error handling
│   ├── schema_spec.lua     -- Schema type utilities
│   └── utils_spec.lua      -- Path handling, etc.
```

Run with Busted outside Neovim:
```bash
busted tests/unit/
```

### Integration Tests (Headless Neovim)

```
tests/
├── integration/
│   ├── minimal_init.lua    -- Minimal plugin config
│   ├── fixtures/           -- Test vault with schema
│   ├── commands_spec.lua   -- :Ovault* commands
│   └── telescope_spec.lua  -- Picker behavior
```

Run with Plenary:
```bash
nvim --headless -c "PlenaryBustedDirectory tests/integration"
```

### What to Test

| Component | Test Type | Coverage Target |
|-----------|-----------|-----------------|
| CLI wrapper | Unit | 90% |
| JSON parsing | Unit | 90% |
| UI components | Integration | 50% |
| Telescope pickers | Integration | 40% |
| Full command flows | Integration | 30% |

### Testing Pain Points & Mitigations

1. **TTY timing** — Use `vim.wait()` with retries
2. **Floating window state** — Assert buffer contents, not visual layout
3. **CLI mocking** — Allow injecting mock responses for unit tests
4. **Fixtures** — Share test vault with CLI tests if possible

---

## Dependencies

**Required:**
- Neovim 0.9+ (for `vim.ui`, floating windows, diagnostics API)
- `ovault` CLI installed and in PATH

**Optional:**
- `telescope.nvim` — Enhanced pickers
- `nvim-cmp` — Wikilink completion
- `plenary.nvim` — Testing and async utilities

---

## Configuration

```lua
require("ovault").setup({
  -- Path to ovault CLI (default: "ovault")
  cli_path = "ovault",
  
  -- Vault path (default: auto-detect from cwd)
  vault_path = nil,
  
  -- Use Telescope if available (default: true)
  use_telescope = true,
  
  -- Keymaps (default: none, user configures)
  keymaps = {
    new = "<leader>on",
    search = "<leader>os",
    list = "<leader>ol",
    edit = "<leader>oe",
  },
  
  -- Open created notes automatically
  open_on_create = true,
  
  -- Diagnostic settings
  diagnostics = {
    enabled = true,
    on_save = true,  -- Run audit on save
  },
})
```

---

## Implementation Timeline

| Week | Milestone | Deliverables |
|------|-----------|--------------|
| 1 | Setup | Plugin structure, CLI wrapper, error handling |
| 2 | Basic commands | `:OvaultOpen`, `:OvaultSchema` |
| 3 | Telescope | Search picker, type picker |
| 4 | List command | Buffer display, quickfix |
| 5 | UI components | Floating input, select, multi-input |
| 6 | New command | Full interactive flow |
| 7 | Edit command | Current buffer editing |
| 8 | Audit | Diagnostics integration |
| 9 | Bulk | Preview and execute |
| 10 | Completion | Wikilink completion source |
| 11 | Dashboard | Saved queries |
| 12 | Polish | Documentation, edge cases |
| 13 | Testing | Integration test coverage |

---

## Related Issues

- `ovault-tic` — Parent issue: Create Neovim plugin for ovault integration
- `ovault-ng6` — Fuzzy finder window for wikilink insertion
- `ovault-hvf` — Formatted table output for list queries
- `ovault-48g` — Dashboard integration for saved queries

---

## Future Considerations

### Live Preview

Real-time frontmatter validation as you type in the YAML block.

### Obsidian Sync

Detect Obsidian sync conflicts and surface them.

### Mobile Companion

If ovault ever has a mobile story, the Neovim plugin could share config/saved queries.

### LSP Integration

Could provide an LSP server for:
- Wikilink completion
- Frontmatter validation
- Schema-aware field suggestions
