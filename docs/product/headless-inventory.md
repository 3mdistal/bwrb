# Headless Inventory

This document tracks the current state of interactive commands and the proposed behavior when using the global `--non-interactive` flag (Issue #509).

## Command Audit & Proposed `--non-interactive` Behavior

| Command | Current Interactive Prompts | Existing Bypass Flags | Strict `--non-interactive` Behavior |
|---------|-----------------------------|-----------------------|-------------------------------------|
| `init` | Link format, Editor, Confirm overwrite | `-y, --yes`, `-f, --force` | Implies `-y`. Fails fast if `.bwrb` exists and `-f` is missing. |
| `new` | Type picker, Template picker, Field inputs | `--json`, `--template` | Fails fast if type or required fields are missing (requires `--json`). |
| `edit` | Note picker, Field inputs | `--json`, `--picker none` | Fails fast if target is ambiguous or if field updates are needed without `--json`. Implies `--picker none`. |
| `delete` | Note picker, Confirm delete | `-f, --force`, `--picker none` | Fails fast if `-f` is missing or target is ambiguous. Implies `--picker none`. |
| `list` | Note picker (for `--open`), Confirm overwrite (`--save-as`) | `--output json`, `--force` (for save-as) | Implies `--picker none` (fails on ambiguity for `--open`). Fails fast if `--save-as` needs overwrite without `--force`. |
| `search` | Note picker (for `--open`/`--edit`) | `--picker none`, `--json` | Implies `--picker none` (fails on ambiguity). Fails fast on `--edit` without `--json`. |
| `audit` | Interactive guided fixes (`--fix`) | `--auto`, `--execute` | Fails fast if `--fix` is used without `--auto` or `--execute`. |
| `bulk` | Confirm large/cross-type operations | `-x`, `-f, --force`, `-y` | Fails fast if `-f` is missing for confirmation. |
| `template new/edit` | Prompts for name, body, fields | `--json` | Fails fast if `--json` is missing. |
| `template delete` | Note picker, Confirm delete | `-f, --force` | Fails fast if `-f` is missing or target is ambiguous. |
| `dashboard new/edit` | Prompts for inputs, where clauses | `--output json` (returns data) | Fails fast if created without full arguments. |
| `dashboard delete` | Dashboard picker, Confirm delete | `-f, --force` | Fails fast if `-f` is missing or target is ambiguous. |
| `config edit` | Option picker, Value input | `--json <value>` | Fails fast if `--json` is missing. |
