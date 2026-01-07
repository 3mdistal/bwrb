---
title: bwrb completion
description: Shell completion scripts
---

Generate shell completion scripts for tab completion.

## Usage

```bash
bwrb completion <shell>
```

## Shells

### Bash

Add to `~/.bashrc`:

```bash
eval "$(bwrb completion bash)"
```

### Zsh

Add to `~/.zshrc`:

```zsh
eval "$(bwrb completion zsh)"
```

### Fish

Run once:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

## What Gets Completed

- **Commands** — `bwrb <TAB>` shows `new`, `edit`, `list`, etc.
- **Options** — `bwrb list -<TAB>` shows available flags
- **Types** — `bwrb new <TAB>` shows types from schema
- **Paths** — `bwrb list --path <TAB>` shows directories

## See Also

- [Shell completion guide](/automation/shell-completion/)
