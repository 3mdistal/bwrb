#!/bin/zsh

# Test runner for pika.sh
# Usage: ./test_runner.sh [test_name]

set -e

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
PIKA_SH="$(dirname "$SCRIPT_DIR")/pika.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Test state
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
CURRENT_TEST=""

# Temporary test environment
TEST_VAULT=""
TEST_SCHEMA=""

# --- Setup/Teardown ---

setup_test_env() {
    # Create isolated test vault
    TEST_VAULT=$(mktemp -d)

    # Copy fixtures
    cp -r "$FIXTURES_DIR/vault/"* "$TEST_VAULT/" 2> /dev/null || true

    # Copy test schema to .pika/ (new location)
    TEST_SCHEMA="$TEST_VAULT/.pika/schema.json"
    mkdir -p "$(dirname "$TEST_SCHEMA")"
    cp "$FIXTURES_DIR/test_schema.json" "$TEST_SCHEMA"
}

teardown_test_env() {
    if [[ -n "$TEST_VAULT" && -d "$TEST_VAULT" ]]; then
        rm -rf "$TEST_VAULT"
    fi
    TEST_VAULT=""
    TEST_SCHEMA=""
}

# --- Assertions ---

assert_equals() {
    local expected="$1"
    local actual="$2"
    local message="${3:-Values should be equal}"

    if [[ "$expected" == "$actual" ]]; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  Expected: $expected" >&2
        echo "  Actual:   $actual" >&2
        return 1
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local message="${3:-String should contain substring}"

    if [[ "$haystack" == *"$needle"* ]]; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  String: $haystack" >&2
        echo "  Should contain: $needle" >&2
        return 1
    fi
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local message="${3:-String should not contain substring}"

    if [[ "$haystack" != *"$needle"* ]]; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  String: $haystack" >&2
        echo "  Should not contain: $needle" >&2
        return 1
    fi
}

assert_file_exists() {
    local file="$1"
    local message="${2:-File should exist}"

    if [[ -f "$file" ]]; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  File not found: $file" >&2
        return 1
    fi
}

assert_file_not_exists() {
    local file="$1"
    local message="${2:-File should not exist}"

    if [[ ! -f "$file" ]]; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  File exists: $file" >&2
        return 1
    fi
}

assert_file_contains() {
    local file="$1"
    local pattern="$2"
    local message="${3:-File should contain pattern}"

    if grep -q "$pattern" "$file" 2> /dev/null; then
        return 0
    else
        echo "${RED}ASSERTION FAILED: $message${NC}" >&2
        echo "  File: $file" >&2
        echo "  Pattern not found: $pattern" >&2
        return 1
    fi
}

assert_exit_code() {
    local expected="$1"
    local actual="$2"
    local message="${3:-Exit code mismatch}"

    assert_equals "$expected" "$actual" "$message"
}

# --- Test execution ---

run_pika() {
    # Run pika.sh with test vault via --vault flag
    # Args: input_string [additional_args...]
    local input="$1"
    shift

    echo "$input" | "$PIKA_SH" --vault="$TEST_VAULT" "$@" 2>&1
    return $?
}

run_pika_expect_fail() {
    # Run pika.sh expecting failure
    local input="$1"
    shift

    if echo "$input" | "$PIKA_SH" --vault="$TEST_VAULT" "$@" 2>&1; then
        return 1 # Should have failed
    else
        return 0 # Expected failure
    fi
}

run_ovault_expect_fail() {
    # Run ovault.sh expecting failure
    local input="$1"
    shift

    if echo "$input" | "$OVAULT_SH" --vault="$TEST_VAULT" "$@" 2>&1; then
        return 1 # Should have failed
    else
        return 0 # Expected failure
    fi
}

# --- Test framework ---

run_test() {
    local test_name="$1"
    CURRENT_TEST="$test_name"
    TESTS_RUN=$((TESTS_RUN + 1))

    echo -n "${CYAN}Running: $test_name${NC} ... "

    setup_test_env

    if "$test_name"; then
        echo "${GREEN}PASSED${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo "${RED}FAILED${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi

    teardown_test_env
}

print_summary() {
    echo ""
    echo "================================"
    echo "Test Summary"
    echo "================================"
    echo "Total:  $TESTS_RUN"
    echo "${GREEN}Passed: $TESTS_PASSED${NC}"
    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo "${RED}Failed: $TESTS_FAILED${NC}"
    else
        echo "Failed: $TESTS_FAILED"
    fi
    echo "================================"

    if [[ $TESTS_FAILED -gt 0 ]]; then
        return 1
    fi
    return 0
}

# --- Load and run tests ---

main() {
    local filter="${1:-}"

    echo "================================"
    echo "pika.sh Test Suite"
    echo "================================"
    echo ""

    # Source test files
    source "$SCRIPT_DIR/test_new.sh"
    source "$SCRIPT_DIR/test_list.sh"

    # Get all test functions
    local tests=($(typeset -f | grep '^test_' | cut -d' ' -f1))

    for test in "${tests[@]}"; do
        # Filter if specified
        if [[ -n "$filter" && "$test" != *"$filter"* ]]; then
            continue
        fi
        run_test "$test"
    done

    print_summary
}

main "$@"
