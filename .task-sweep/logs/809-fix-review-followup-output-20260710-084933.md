NO BLOCKERS

All three prior findings are resolved:
1. The regression test is deterministic: `DD.MM.YYYY` (dot separators) forces the configured-pattern path, and the before/after `Date` capture asserts the exact canonical local date across midnight, then audits the created note (0 errors).
2. Strict precedence is enforced: when `date_format` is set, non-matching non-ISO input returns invalid instead of falling through to the format-agnostic parser; tests confirm `25/12/2026` is rejected under `MM/DD/YYYY` while canonical ISO and `YYYY-MM` partials still pass.
3. `dateFormat` is appended after all existing optional parameters in `normalizeToIsoDate`, `normalizeDateValue`, `validateDateValue`, and `validateFieldType`; scalar and list paths pass it identically.

`escapeRegExp` covers all metacharacters (tested with `.(MM)+`), and `validateDateComponents` guards leap-year/range validity. Docs consistently state canonical ISO storage.

Non-blocking notes:
- Years below 100 (e.g. `0099`) via `new Date(year, …)` map to 1900+; if `validateDateComponents` doesn't floor the year, canonicalization could silently shift — consider `setFullYear` or explicit range check.
- The `split(token).length === 2` uniqueness check treats a stray adjacent literal `M`/`D` oddly (e.g. `MMM`); config-edit validation likely prevents this, but worth a defensive test.