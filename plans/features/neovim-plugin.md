# Neovim Plugin for Pika

> Native Neovim integration with full CLI feature parity

**Beads Issue:** `pika-tic`

---

## Overview

A Neovim plugin (`pika.nvim`) that brings the full power of pika into the editor. The goal is **feature parity with the CLI** for human-usable operations, making Neovim a complete PKM (Personal Knowledge Management) environment.

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
│                    pika.nvim                             │
│  • CLI wrapper (--json mode)                            │
│  • Native Lua for hot paths                             │
│  • UI component library                                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    pika CLI                              │
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
- **Shared schema understanding** via parsed JSON from `pika schema show --output json`

---

## Command Mapping

| CLI Command | Neovim Command | Implementation |
|-------------|----------------|----------------|
| `pika new [type]` | `:PikaNew [type]` | CLI + floating inputs |
| `pika edit <file>` | `:PikaEdit` | CLI + floating inputs |
| `pika list <type>` | `:PikaList <type>` | CLI + buffer/Telescope |
| `pika search <query>` | `:PikaSearch` | CLI + Telescope |
| `pika open <file>` | `:PikaOpen` | Native `:edit` |
| `pika audit` | `:PikaAudit` | CLI + diagnostics |
| `pika bulk` | `:PikaBulk` | CLI + preview buffer |
| `pika schema show` | `:PikaSchema` | CLI + floating window |
| `pika template list` | `:PikaTemplates` | CLI + Telescope |

---

## Phase 1: Foundation (Weeks 1-3)

### 1.1 Core Infrastructure

```lua
-- lua/pika/init.lua
local M = {}

M.setup = function(opts)
  -- Vault detection (find .pika/schema.json)
  -- CLI path configuration
  -- Keybinding setup
end

return M
```

**Deliverables:**
- [ ] Plugin structure with lazy.nvim/packer support
- [ ] Vault detection (walk up to find `.pika/`)
- [ ] CLI wrapper module (`lua/pika/cli.lua`)
- [ ] JSON response parser
- [ ] Error handling with `vim.notify`

### 1.2 Basic Commands

**`:PikaOpen [query]`** — Open note by name
- Uses `pika search --json` for resolution
- Falls back to Telescope if ambiguous
- Direct `:edit` for exact match

**`:PikaList <type>`** — List notes in buffer
- Calls `pika list <type> --output json`
- Renders in scratch buffer or quickfix
- Supports `--where` expressions

**`:PikaSchema`** — Show schema tree
- Calls `pika schema show`
- Floating window with type hierarchy

### 1.3 Telescope Integration

```lua
-- lua/telescope/_extensions/pika.lua
return require("telescope").register_extension({
  exports = {
    search = require("pika.telescope.search"),
    list = require("pika.telescope.list"),
    types = require("pika.telescope.types"),
  },
})
```

**Pickers:**
- `Telescope pika search` — Note search with wikilink output
- `Telescope pika list` — Filtered list with type selection
- `Telescope pika types` — Type hierarchy navigation

---

## Phase 2: Interactive Commands (Weeks 4-7)

### 2.1 Floating Input Windows

Custom UI for schema-driven prompts:

```lua
-- lua/pika/ui/input.lua
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

### 2.2 `:PikaNew [type]`

Interactive note creation:

1. If no type, show type picker (Telescope or floating select)
2. Navigate subtypes if needed
3. Prompt for template if multiple available
4. Show floating inputs for each field (respecting schema order)
5. Call `pika new <type> --json '{...}'`
6. Open created file

**Flow diagram:**
```
:PikaNew
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
    └─► pika new --json → :edit <path>
```

### 2.3 `:PikaEdit`

Edit frontmatter of current buffer:

1. Detect type from frontmatter
2. Show current values with edit prompts
3. Call `pika edit <path> --json '{...}'`
4. Refresh buffer

---

## Phase 3: Advanced Features (Weeks 8-10)

### 3.1 `:PikaAudit` with Diagnostics

```lua
-- Register diagnostic namespace
local ns = vim.diagnostic.get_namespace("pika")

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
        source = "pika",
      })
    end
    vim.diagnostic.set(ns, bufnr, diagnostics)
  end
end
```

**Features:**
- Populate `vim.diagnostic` for all open buffers
- Quickfix list with all issues
- `:PikaAuditFix` for interactive fixing

### 3.2 `:PikaBulk`

Bulk operations with preview:

1. Show matching files in preview buffer
2. Display proposed changes
3. Confirm before execution
4. Call `pika bulk --execute`

### 3.3 Wikilink Completion

```lua
-- lua/pika/completion.lua
-- Integrates with nvim-cmp or built-in completion

-- Trigger on [[ 
-- Call pika search --json with prefix
-- Return completion items with wikilink format
```

---

## Phase 4: Polish & Ecosystem (Weeks 11-13)

### 4.1 Dashboard Integration

Saved queries (linked issue: `pika-48g`):

```lua
:PikaDashboard           -- Show saved query list
:PikaDashboardSave       -- Save current list query
:PikaDashboardRun <name> -- Run saved query
```

### 4.2 Formatted Table Output

Better list display (linked issue: `pika-hvf`):

- Aligned columns in buffer
- Sortable headers
- Click-to-open

### 4.3 Wikilink Insertion Picker

Fuzzy finder for links (linked issue: `pika-ng6`):

```lua
:PikaLink           -- Insert [[wikilink]] at cursor
:PikaLinkVisual     -- Wrap selection in [[]]
```

### 4.4 Status Line Integration

```lua
-- For lualine, etc.
require("pika").statusline()
-- Returns: "pika: Tasks (12 active)"
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
│   ├── commands_spec.lua   -- :Pika* commands
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
- `pika` CLI installed and in PATH

**Optional:**
- `telescope.nvim` — Enhanced pickers
- `nvim-cmp` — Wikilink completion
- `plenary.nvim` — Testing and async utilities

---

## Configuration

```lua
require("pika").setup({
  -- Path to pika CLI (default: "pika")
  cli_path = "pika",
  
  -- Vault path (default: auto-detect from cwd)
  vault_path = nil,
  
  -- Use Telescope if available (default: true)
  use_telescope = true,
  
  -- Keymaps (default: none, user configures)
  keymaps = {
    new = "<leader>pn",
    search = "<leader>ps",
    list = "<leader>pl",
    edit = "<leader>pe",
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
| 2 | Basic commands | `:PikaOpen`, `:PikaSchema` |
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

- `pika-tic` — Parent issue: Create Neovim plugin for pika integration
- `pika-ng6` — Fuzzy finder window for wikilink insertion
- `pika-hvf` — Formatted table output for list queries
- `pika-48g` — Dashboard integration for saved queries

---

## Future Considerations

### Live Preview

Real-time frontmatter validation as you type in the YAML block.

### Obsidian Sync

Detect Obsidian sync conflicts and surface them.

### Mobile Companion

If pika ever has a mobile story, the Neovim plugin could share config/saved queries.

### LSP Integration

Could provide an LSP server for:
- Wikilink completion
- Frontmatter validation
- Schema-aware field suggestions
