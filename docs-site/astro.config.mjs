// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://bwrb.dev',
	// Redirects for consolidated CLI reference pages (issue #257)
	// Old subcommand URLs redirect to anchor sections in parent pages
	redirects: {
		'/reference/commands/config/list/': '/reference/commands/config/#list',
		'/reference/commands/config/edit/': '/reference/commands/config/#edit',
		'/reference/commands/schema/list/': '/reference/commands/schema/#list',
		'/reference/commands/schema/validate/': '/reference/commands/schema/#validate',
		'/reference/commands/schema/diff/': '/reference/commands/schema/#diff',
		'/reference/commands/schema/migrate/': '/reference/commands/schema/#migrate',
		'/reference/commands/schema/history/': '/reference/commands/schema/#history',
		'/reference/commands/template/list/': '/reference/commands/template/#list',
		'/reference/commands/template/new/': '/reference/commands/template/#new',
		'/reference/commands/template/edit/': '/reference/commands/template/#edit',
		'/reference/commands/template/delete/': '/reference/commands/template/#delete',
		'/reference/commands/template/validate/': '/reference/commands/template/#validate',
	},
	integrations: [
		starlight({
			title: 'Bowerbird',
			tagline: 'The type system for your notes',
			description: 'Schema-driven note management for markdown vaults',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/3mdistal/bwrb' },
			],
			customCss: [
				'./src/styles/custom.css',
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
						{ slug: 'concepts/cli-safety-and-flags' },
					],
				},
				// CLI Reference
				{
					label: 'CLI Reference',
					items: [
						{ slug: 'reference/targeting' },
						{ slug: 'reference/schema' },
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
