// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://bwrb.dev',
	integrations: [
		starlight({
			title: 'Bowerbird',
			tagline: 'The type system for your notes',
			description: 'Schema-driven note management for markdown vaults',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/3mdistal/bwrb' },
			],
			sidebar: [
				// Getting Started (high priority for onboarding)
				{
					label: 'Getting Started',
					items: [
						{ slug: 'getting-started/introduction' },
						{ slug: 'getting-started/installation' },
						{ slug: 'getting-started/quick-start' },
					],
				},
				// Core Concepts (V1.0 / Schema - the inner circle)
				{
					label: 'Core Concepts',
					items: [
						{ slug: 'concepts/schema' },
						{ slug: 'concepts/types-and-inheritance' },
						{ slug: 'concepts/validation-and-audit' },
						{ slug: 'concepts/migrations' },
					],
				},
				// CLI Reference
				{
					label: 'CLI Reference',
					items: [
						{ slug: 'reference/targeting' },
						{
							label: 'Commands',
							collapsed: true,
							autogenerate: { directory: 'reference/commands' },
						},
					],
				},
				// Templates
				{
					label: 'Templates',
					collapsed: true,
					items: [
						{ slug: 'templates/overview' },
						{ slug: 'templates/creating-templates' },
					],
				},
				// Automation (JSON mode, scripting)
				{
					label: 'Automation',
					collapsed: true,
					items: [
						{ slug: 'automation/json-mode' },
						{ slug: 'automation/shell-completion' },
						{ slug: 'automation/ai-integration' },
					],
				},
				// Product (living docs)
				{
					label: 'Product',
					collapsed: true,
					items: [
						{ slug: 'product/vision' },
						{ slug: 'product/roadmap' },
					],
				},
				// Changelog
				{ label: 'Changelog', slug: 'changelog' },
			],
			// Customize the head
			head: [
				{
					tag: 'meta',
					attrs: {
						name: 'keywords',
						content: 'bowerbird, bwrb, markdown, schema, notes, pkm, cli',
					},
				},
			],
		}),
	],
});
