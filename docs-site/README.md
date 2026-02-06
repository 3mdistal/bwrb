# Bowerbird Documentation Site

Documentation for [bwrb](https://github.com/3mdistal/bwrb), built with [Starlight](https://starlight.astro.build).

**Live site**: https://bwrb.dev

## Development

```bash
pnpm --dir docs-site install
pnpm --dir docs-site dev      # Start dev server at localhost:4321
pnpm --dir docs-site build    # Build production site
pnpm --dir docs-site preview  # Preview production build
```

## Contributor Troubleshooting

### pnpm warns about ignored build scripts (`approve-builds`)

Symptom (fresh install): pnpm warns that build scripts were ignored and suggests `pnpm approve-builds`.

- Why this happens: pnpm blocks dependency build scripts by default until approved; docs-site commonly needs `sharp`.
- What to do:

```bash
pnpm --dir docs-site install
pnpm --dir docs-site approve-builds
# In the prompt, select sharp (Space) and confirm (Enter)
pnpm --dir docs-site rebuild sharp
pnpm --dir docs-site build
```

Only approve packages you recognize and expect for this project.

### TS/IDE errors like `Cannot find module 'astro/config'`

Symptom (before docs-site deps are installed): editors may show missing Astro modules or tsconfig errors (for example `astro/config` or `astro/tsconfigs/strict`).

- Why this happens: the TypeScript server cannot resolve Astro packages until `docs-site` dependencies are installed.
- What to do:

```bash
pnpm --dir docs-site install
pnpm --dir docs-site astro sync
# optional but useful for generated types and runtime checks
pnpm --dir docs-site dev
```

If diagnostics persist after install/sync, restart your editor's TypeScript server. Opening `docs-site/` as its own workspace root also helps keep module resolution clean.

## Deployment

The docs are hosted on Vercel and connected to GitHub.

### Automatic Deployments

Vercel is configured with an **Ignored Build Step** to only build when `docs-site/` changes:

```bash
git diff HEAD^ HEAD --quiet -- ./docs-site
```

This means:
- PRs that only touch source code (`src/`, `tests/`) → **no Vercel build**
- PRs that touch `docs-site/` → **Vercel builds automatically**

### Manual Deployments

If you need to trigger a manual deployment (e.g., after rate limiting):

```bash
pnpm --dir docs-site exec vercel        # Deploy preview
pnpm --dir docs-site exec vercel --prod # Deploy to production
```

> **Note**: You need to be authenticated with the Vercel CLI (`vercel login`) and have access to the project.

### Rate Limiting

Vercel's free plan has build limits. The Ignored Build Step helps conserve builds by skipping deployments for non-docs changes. If you hit the rate limit:

1. Wait for the cooldown period (shown in Vercel dashboard)
2. Use manual deployment when ready
3. Consider batching docs changes to reduce build frequency

## Project Structure

```
docs-site/
├── src/
│   ├── content/
│   │   └── docs/          # Markdown documentation pages
│   └── assets/            # Images and static assets
├── public/                # Favicons, robots.txt
├── astro.config.mjs       # Astro + Starlight config
├── vercel.json            # Vercel deployment config
└── package.json
```

Documentation pages in `src/content/docs/` are exposed as routes based on their file path.
