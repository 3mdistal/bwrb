---
title: Installation
description: How to install Bowerbird
---

## Prerequisites

- **Node.js** >= 22

Check your Node.js version:

```bash
node --version  # Should be v22.0.0 or higher
```

## Install from npm

```bash
npm install -g bwrb
```

Or with pnpm:

```bash
pnpm add -g bwrb
```

## Install from Source

Clone the repository and build:

```bash
git clone https://github.com/3mdistal/bwrb.git
cd bwrb
pnpm install
pnpm build
pnpm link --global  # Makes 'bwrb' available globally
```

### Development Mode

Run without building (useful for contributing):

```bash
pnpm dev -- new idea
```

## Verify Installation

```bash
bwrb --version
bwrb --help
```

You should see the version number and a list of available commands.

## Shell Completion

Enable tab completion for commands, types, and paths. See [Shell Completion](/automation/shell-completion/) for advanced configuration.

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

Run once to install:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

### What Gets Completed

- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `open`, etc.
- **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
- **Types**: `bwrb list --type <TAB>` shows types from your schema
- **Paths**: `bwrb list --path <TAB>` shows vault directories

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BWRB_VAULT` | Default vault path | Current directory |
| `BWRB_DEFAULT_APP` | Default app for `bwrb open` | `system` |
| `EDITOR` / `VISUAL` | Editor for `--app editor` | — |

Example:

```bash
export BWRB_VAULT=~/notes
export BWRB_DEFAULT_APP=editor
```

## Uninstall

If installed via npm:

```bash
npm uninstall -g bwrb
```

If installed from source:

```bash
pnpm unlink --global  # In the bwrb directory
```

## Troubleshooting

### "command not found: bwrb"

Make sure your npm global bin directory is in your PATH:

```bash
npm bin -g  # Shows the global bin path
```

Add this path to your shell configuration if needed.

### Permission errors on npm install

Use a Node version manager like [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to avoid permission issues with global installs.

## Next Steps

Once installed, see the [Quick Start](/getting-started/quick-start/) guide to create your first schema and note.
