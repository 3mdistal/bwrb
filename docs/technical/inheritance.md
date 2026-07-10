# Inheritance Resolution Notes

> Concise maintainer notes for the shipped version 2 schema resolver.

User-facing behavior is canonical in the docs-site
[Types and Inheritance](../../docs-site/src/content/docs/concepts/types-and-inheritance.md)
and [Schema Reference](../../docs-site/src/content/docs/reference/schema.md).
Product rationale lives in [Type System](../product/type-system.md).

## Resolution layers

Types form a single-parent `extends` tree rooted at implicit `meta`. Effective
fields are assembled in this precedence order, highest first:

```text
own type fields > traits > inherited parent fields
```

- Parent fields are inherited through the ancestor chain.
- Traits are composed in declaration order. A trait field fully replaces the
  inherited field of the same name; a later trait replaces an earlier trait.
- An own field fully replaces a colliding trait field.
- An own field colliding directly with an inherited parent field is an
  **explicit-key merge**: every locally declared key wins, including structural
  keys such as `prompt`, `options`, `multiple`, `required`, and `source`; omitted
  keys stay inherited.

The resolver implementation is `computeEffectiveFields` in
`src/lib/schema.ts`. Migration comparison uses each concrete type's effective
old and new fields in `src/lib/migration/diff.ts`, so a parent change fans out
only to descendants whose effective field actually changes.

## Related systems

- `field_order` follows the same inheritance/trait/own layering unless a type
  supplies a complete explicit order.
- Relation `source` accepts a type name, an array of type names, or `any`; a
  parent type source includes descendants.
- Ownership is declared with `owned: true` on a relation field and is separate
  from type inheritance.
- Recursive note hierarchies use ordinary relation fields (typically `parent`)
  and do not add a second type-inheritance mechanism.

Do not mirror the complete user contract here. Update the canonical docs-site
pages alongside resolver changes and keep this note focused on implementation
topology.
