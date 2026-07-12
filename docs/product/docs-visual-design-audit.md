# How should the Bowerbird docs become more modern and attractive?

## Answer

Bowerbird does not need a prettier Starlight theme. It needs a small visual system that makes the product's
central idea visible: **structure emerging from plain text**.

The current site is clear and usable, but visually generic. Its identity is mostly a blue accent, a gradient
tagline, hover motion, and a stock-like abstract hero image. The homepage explains the product, but it does
not yet *demonstrate* it. Interior documentation pages inherit sensible Starlight defaults, though their
hierarchy, navigation density, and code surfaces feel utilitarian rather than crafted.

The recommended direction is **The Living Schema**: a calm, editorial documentation system built around
fine structural lines, YAML-to-typed-note transformations, monospace metadata, and a restrained mineral
palette. Borrow Vercel's confidence and Linear's atmosphere, not either company's costume.

## Evidence

### Current Bowerbird site

The homepage currently consists of a standard Starlight splash hero, four stock cards, and one code block
(`docs-site/src/content/docs/index.mdx`). The only substantial visual customization is a blue accent palette,
a gradient tagline, card hover movement, and code-block shadow (`docs-site/src/styles/custom.css`).

Live inspection on 2026-07-12 found:

- a generic system sans-serif stack;
- a 64px/600-weight homepage title paired with a 1.5rem blue gradient tagline;
- one decorative image that does not explain the product;
- almost no visual texture beyond the tagline gradient;
- interior pages using a readable 652px article measure and 16px/28px body type, but with default-feeling
  headings, navigation, active states, and code frames;
- a dense right-hand table of contents on longer pages, such as Quick Start, that competes with the article.

This is a strong information foundation. The problem is not polish in isolated controls; it is that the site
has no recurring visual grammar connecting the homepage, navigation, examples, and product idea.

### What the reference sites do well

Vercel's homepage uses a neutral canvas, unusually generous negative space, a restrained black-and-white
core, large regular-weight type, geometric brand imagery, and product/customer evidence as composition.
The visible hero is not crowded, and its 64px headline has room to breathe. The result feels confident
because very few elements are asked to carry a great deal of hierarchy.

Linear's homepage uses a dark near-black ground, subtle borders and glows, muted secondary text, controlled
gradients, and large product-interface compositions. Its visual identity repeats through every layer: header,
hero, figures, captions, and screenshots. The atmosphere comes from consistency and depth, not ornamental
noise.

The transferable lesson is not “make it monochrome” or “add glows.” Both sites:

1. establish one unmistakable art direction;
2. use type and space as primary visual material;
3. show the product instead of substituting feature cards for evidence;
4. repeat a small set of motifs across the whole page;
5. keep color rare enough that action and meaning remain legible.

### Feasibility in the current stack

The site uses Astro 5 and Starlight 0.37. Starlight supports custom CSS for broad visual changes and targeted
component overrides when markup must change. Overrides can also render conditionally for the homepage,
which means Bowerbird can preserve Starlight's durable documentation shell while giving the landing page a
distinct composition. A rewrite or framework migration is unnecessary.

## Inferences

### Design principles

1. **Make structure the decoration.** Use schema lines, field labels, validation marks, hierarchy, and
   transformations as the visual motif. Bowerbird's subject is already graphical.
2. **Show the before and after.** The most persuasive hero artifact is an animated or stepped transformation:
   loose Markdown/YAML becomes a validated typed note, then a queryable collection.
3. **Prefer quiet confidence.** Use one cool accent and one warm signal color against ink/stone neutrals.
   Avoid a rainbow SaaS gradient; the internet has met several already.
4. **Separate marketing rhythm from reading rhythm.** The homepage can be expressive. Documentation pages
   should remain calm, compact, and extremely legible.
5. **Build identity from reusable tokens.** Typography, borders, radii, shadows, spacing, and motion should
   be defined once and repeated rather than tuned page by page.

### Proposed visual direction: The Living Schema

**Palette**

- Light canvas: warm paper (`#F7F7F4`) rather than pure white.
- Dark canvas: blue-black ink (`#090B10`) rather than neutral black.
- Primary text: ink (`#15171A`) / frost (`#F3F5F7`).
- Structural lines: low-contrast slate with two opacity levels.
- Accent: electric cobalt, slightly less saturated than the current blue.
- Semantic spark: a restrained chartreuse or amber used only for valid/changed states.

**Typography**

- Use a modern variable grotesk for interface and display text (Geist is a natural open choice), paired with
  a characterful monospace for commands, field labels, figure captions, and schema metadata.
- Reduce homepage headline weight from 600 to roughly 450–520 and let scale plus spacing provide authority.
- Tighten heading tracking slightly; loosen body leading and increase body text contrast.
- Introduce small monospace eyebrow labels such as `SCHEMA / 01`, `VALIDATE / 02`, and `MIGRATE / 03`.

**Visual grammar**

- Hairline grids that subtly align hero copy, terminal output, and section boundaries.
- Thin connectors between schema fields and rendered note values.
- Small validation pulses/checks, with motion disabled under `prefers-reduced-motion`.
- Square-to-soft (6–10px) radii rather than fully pill-shaped everything.
- Very restrained shadows; use borders, inner highlights, and background planes for depth.
- Product diagrams rendered from real Bowerbird examples, not abstract stock imagery.

## Recommendation

### Priority 0 — establish the system

Create a compact token layer in `custom.css` for color, type, spacing, borders, radii, shadows, and motion.
Add the chosen font assets with good fallbacks. Restyle the global header, search, sidebar, table of contents,
article typography, links, focus states, code blocks, tables, callouts, and active navigation.

This pass should make every page feel intentional even before the homepage is rebuilt.

### Priority 1 — rebuild the homepage around product evidence

Replace the stock splash composition and `hero.jpeg` with a custom homepage component or MDX composition:

1. **Hero:** “Your notes, with a type system.” Pair the statement with a live schema-to-note transformation.
2. **Proof strip:** three concise truths—plain Markdown, local-first, automation-ready—rather than logo theater.
3. **Product story:** a three-part visual sequence: define → create → audit/migrate.
4. **Real terminal moment:** a polished but authentic command interaction with output, not commands alone.
5. **Capabilities:** replace four generic cards with editorial feature rows tied to real product surfaces.
6. **Closing invitation:** one strong next step into Quick Start and one quieter GitHub link.

Keep the homepage concise. Its job is to create desire and orientation, not reproduce the entire sidebar in
evening wear.

### Priority 2 — improve the documentation reading surface

- Give article titles a clearer title/dek/metadata hierarchy.
- Make the left navigation quieter and the active item more distinctive without using a full saturated bar.
- Reduce right-rail competition: stronger section grouping, softer inactive links, sticky position with sane
  maximum height.
- Give code blocks a consistent terminal/editor frame only when context benefits from it; keep inline and
  reference snippets simpler.
- Style tables, steps, tabs, callouts, and command signatures as a coherent component family.
- Add subtle previous/next navigation with section context.
- Verify light and dark themes as equal designs rather than treating dark mode as recoloring.

### Priority 3 — add signature details

- A small custom Bowerbird mark derived from nested schema brackets or a woven field grid.
- Lightweight diagrams for inheritance, migrations, ownership, and lineage.
- Syntax-aware highlights that distinguish fields, values, types, and validation outcomes.
- One purposeful entrance sequence on the homepage, under 500ms and reduced-motion safe.

### What not to do

- Do not copy Vercel's triangle/minimal black-and-white system or Linear's purple-blue glow language.
- Do not solve the homepage with a larger gradient headline and more cards.
- Do not put animation on ordinary documentation navigation.
- Do not trade article contrast, keyboard focus, or scanability for atmosphere.
- Do not override Starlight's entire layout when CSS and a homepage-only component override will suffice.

### Suggested implementation slices

1. **Visual-system prototype:** tokens plus one homepage hero and one representative long documentation page.
2. **Homepage build:** custom composition and real product diagrams.
3. **Documentation shell:** navigation, article typography, code, tables, and callouts.
4. **Responsive/accessibility pass:** mobile hierarchy, keyboard navigation, reduced motion, contrast, and
   layout-shift checks.
5. **Visual regression pass:** light/dark screenshots at desktop and mobile widths.

The first slice is the right next step because it tests the art direction on both kinds of page before the
system spreads. A good prototype should answer one question: **does The Living Schema feel like Bowerbird,
or merely like tasteful developer tooling?**

## Uncertainties

- The wordmark and hero image may have history or meaning not visible in the repository.
- The preferred personality could tilt warmer/editorial or darker/technical; both fit the concept, but the
  choice is taste rather than discoverable fact.
- The audit did not include user analytics, so navigation-density recommendations are based on visual and
  content inspection rather than observed reading behavior.
- Before production, font licensing, performance budgets, and the exact Starlight override boundaries should
  be confirmed in a small prototype.

## Sources

- Current site: <https://bwrb.dev/>
- Current Quick Start: <https://bwrb.dev/getting-started/quick-start/>
- Vercel homepage: <https://vercel.com/>
- Linear homepage: <https://linear.app/>
- Starlight component overrides: <https://starlight.astro.build/guides/overriding-components/>
- Starlight overrides reference: <https://starlight.astro.build/reference/overrides/>
