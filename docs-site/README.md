# Bowerbird Documentation Site

Documentation for [bwrb](https://github.com/3mdistal/bwrb), built with [Starlight](https://starlight.astro.build).

**Live site**: https://bwrb.dev

## Development

```bash
cd docs-site
pnpm install
pnpm dev        # Start dev server at localhost:4321
pnpm build      # Build production site
pnpm preview    # Preview production build
```

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
cd docs-site
vercel          # Deploy preview
vercel --prod   # Deploy to production
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
