---
title: Installation
description: How to install Bowerbird
---

## Prerequisites

- **Node.js** >= 18

## From Source (Development)

```bash
git clone https://github.com/3mdistal/bwrb.git
cd bwrb
pnpm install
pnpm build
pnpm link --global  # Makes 'bwrb' available globally
```

## Development Mode

Run without building:

```bash
pnpm dev -- new idea
```

## Verify Installation

```bash
bwrb --version
bwrb --help
```

## Next Steps

Once installed, see the [Quick Start](/getting-started/quick-start/) guide to create your first schema and note.
