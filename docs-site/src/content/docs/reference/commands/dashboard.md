---
title: bwrb dashboard
description: Run saved queries
---

Execute saved list queries (dashboards).

## Usage

```bash
bwrb dashboard <name>
```

## Creating Dashboards

Save a query with `--save-as`:

```bash
bwrb list task --where "status = 'active'" --save-as "active-tasks"
```

## Running Dashboards

```bash
bwrb dashboard active-tasks
```

## Listing Dashboards

```bash
bwrb dashboard list
```

## See Also

- [bwrb list](/reference/commands/list/)
