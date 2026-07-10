NO BLOCKERS

The prior blocker is resolved: `validateConfigValue` now rejects non-string and incomplete/duplicated-token patterns for `date_format` before write, tests assert byte-identical schema for both invalid forms (type mismatch `42` and incomplete `"YYYY-MM"`), and docs state the exactly-once contract. The exhaustive classification test (`CONFIG_OPTION_KEYS` + intentionally unexposed keys == `ConfigSchema.shape`) prevents silent drift, and leaving `ConfigSchema` unchanged preserves hand-authored schemas as intended. Verification (build, typecheck, lint, focused source/dist/PTY tests, docs checks, plus the earlier full gate) is sufficient for this scope.

Non-blocking notes:
- The `split(token).length === 2` check permits adjacent extra characters that overlap a token boundary (e.g., `"YYYYY-MM-DD"` passes, and single-replacement formatting would leave a stray literal `Y`). Rare and cosmetic; a follow-up could tighten to token-boundary matching.
- Invalid input on the interactive `date_format` path isn't PTY-tested (only the valid entry is). Acceptable since validation is shared with the JSON path, which is covered.
- The removed roadmap bullet and #809 references are consistently cleaned up across both doc trees — no stale links spotted in the diff.