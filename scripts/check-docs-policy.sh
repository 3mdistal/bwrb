#!/usr/bin/env bash
set -euo pipefail

fail() {
	printf 'docs-policy-check: %s\n' "$1" >&2
	exit 1
}

contains() {
	local file="$1"
	local needle="$2"
	if ! rg -Fq -- "$needle" "$file"; then
		fail "missing '${needle}' in ${file}"
	fi
}

contains "README.md" "https://bwrb.dev"
contains "README.md" "docs/product/canonical-docs-policy.md"

contains "AGENTS.md" "https://bwrb.dev"
contains "AGENTS.md" "docs/product/canonical-docs-policy.md"

contains "docs/product/vision.md" "docs/product/canonical-docs-policy.md"
contains "docs/product/cli-targeting.md" "docs/product/canonical-docs-policy.md"
contains "docs/product/cli-output-contract.md" "docs/product/canonical-docs-policy.md"

printf 'docs-policy-check: ok\n'
