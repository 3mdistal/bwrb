#!/bin/zsh

# Test cases for ovault list command
# These are sourced by test_runner.sh

# ============================================
# List Command Basic Tests
# ============================================

test_list_help_without_type() {
    local output
    output=$(run_ovault "" list 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should exit with error when no type provided"
    assert_contains "$output" "Usage:" "Should show usage"
    assert_contains "$output" "Available types:" "Should show available types"
}

test_list_unknown_type() {
    local output
    output=$(run_ovault "" list nonexistent 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should exit with error for unknown type"
    assert_contains "$output" "Unknown type" "Should report unknown type"
}

# ============================================
# List Leaf Type Tests
# ============================================

test_list_idea_type() {
    # Ideas fixture has "Sample Idea" and "Another Idea"
    local output=$(run_ovault "" list idea)

    assert_contains "$output" "Sample Idea" "Should list Sample Idea"
    assert_contains "$output" "Another Idea" "Should list Another Idea"
}

test_list_results_sorted() {
    local output=$(run_ovault "" list idea)

    # "Another Idea" should come before "Sample Idea" alphabetically
    local another_line=$(echo "$output" | grep -n "Another Idea" | cut -d: -f1)
    local sample_line=$(echo "$output" | grep -n "Sample Idea" | cut -d: -f1)

    [[ $another_line -lt $sample_line ]]
}

# ============================================
# List Subtype Tests
# ============================================

test_list_subtype_task() {
    # Tasks fixture has "Sample Task"
    local output=$(run_ovault "" list objective/task)

    assert_contains "$output" "Sample Task" "Should list Sample Task"
}

test_list_subtype_milestone() {
    # Milestones fixture has "Active Milestone" and "Settled Milestone"
    local output=$(run_ovault "" list objective/milestone)

    assert_contains "$output" "Active Milestone" "Should list Active Milestone"
    assert_contains "$output" "Settled Milestone" "Should list Settled Milestone"
}

# ============================================
# List Parent Type Tests (includes subtypes)
# ============================================

test_list_parent_type_includes_all_subtypes() {
    # objective should include both tasks and milestones
    local output=$(run_ovault "" list objective)

    assert_contains "$output" "Sample Task" "Should include tasks"
    assert_contains "$output" "Active Milestone" "Should include milestones"
    assert_contains "$output" "Settled Milestone" "Should include milestones"
}

test_list_entity_parent_type() {
    # entity has person subtype, but no fixture files exist yet
    # Should return empty (no error)
    local output
    output=$(run_ovault "" list entity)
    local exit_code=$?

    assert_equals "0" "$exit_code" "Should succeed even with no files"
}

# ============================================
# List Empty Directory Tests
# ============================================

test_list_empty_type() {
    # entity/person has no fixture files
    local output
    output=$(run_ovault "" list entity/person)
    local exit_code=$?

    assert_equals "0" "$exit_code" "Should succeed with empty directory"
    # Output should be empty or whitespace only
    [[ -z "${output// /}" ]]
}

# ============================================
# Type Path Parsing Tests
# ============================================

test_list_deep_subtype_nonexistent() {
    # Test invalid deep path
    local output
    output=$(run_ovault "" list objective/task/invalid 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should fail for invalid deep path"
    assert_contains "$output" "Unknown type" "Should report unknown type"
}

# ============================================
# List --output paths Tests
# ============================================

test_list_paths_flag() {
    local output=$(run_ovault "" list --output paths idea)

    assert_contains "$output" "Ideas/Sample Idea.md" "Should show full path for Sample Idea"
    assert_contains "$output" "Ideas/Another Idea.md" "Should show full path for Another Idea"
}

test_list_paths_with_subtype() {
    local output=$(run_ovault "" list --output paths objective/task)

    assert_contains "$output" "Objectives/Tasks/Sample Task.md" "Should show full path for task"
}

# ============================================
# List --fields Flag Tests
# ============================================

test_list_fields_single() {
    local output=$(run_ovault "" list --fields=status idea)

    assert_contains "$output" "NAME" "Should have NAME header"
    assert_contains "$output" "STATUS" "Should have STATUS header"
    assert_contains "$output" "raw" "Should show status value"
}

test_list_fields_multiple() {
    local output=$(run_ovault "" list --fields=type,status objective/task)

    assert_contains "$output" "NAME" "Should have NAME header"
    assert_contains "$output" "TYPE" "Should have TYPE header"
    assert_contains "$output" "STATUS" "Should have STATUS header"
    assert_contains "$output" "objective" "Should show type value"
    assert_contains "$output" "in-flight" "Should show status value"
}

test_list_fields_with_paths() {
    local output=$(run_ovault "" list --output paths --fields=status idea)

    assert_contains "$output" "PATH" "Should have PATH header instead of NAME"
    assert_contains "$output" "Ideas/" "Should show path"
}

test_list_fields_missing_value() {
    # Ideas don't have 'deadline' field, should show placeholder
    local output=$(run_ovault "" list --fields=deadline idea)

    assert_contains "$output" "DEADLINE" "Should have DEADLINE header"
    # Should have placeholder character for missing values
    assert_contains "$output" "—" "Should show placeholder for missing field"
}

# ============================================
# Filter Tests - Basic Equality
# ============================================

test_filter_equality_single_value() {
    # Sample Task has status: in-flight
    local output=$(run_ovault "" list objective/task --status=in-flight)

    assert_contains "$output" "Sample Task" "Should include task with matching status"
}

test_filter_equality_no_match() {
    # Sample Task has status: in-flight, not raw
    local output=$(run_ovault "" list objective/task --status=raw)

    # Output should be empty
    [[ -z "${output// /}" ]] || fail "Should return empty when no items match filter"
}

test_filter_equality_multiple_results() {
    # Both milestones have status: in-flight or settled
    # Active Milestone is in-flight, Settled Milestone is... settled? Let's check
    local output=$(run_ovault "" list objective/milestone --status=in-flight)

    assert_contains "$output" "Active Milestone" "Should include milestone with in-flight status"
}

# ============================================
# Filter Tests - OR (multiple values)
# ============================================

test_filter_or_values() {
    # Match status=raw OR status=backlog
    # Sample Idea has status: raw, Another Idea has status: backlog
    local output=$(run_ovault "" list idea --status=raw,backlog)

    assert_contains "$output" "Sample Idea" "Should include idea with raw status"
    assert_contains "$output" "Another Idea" "Should include idea with backlog status"
}

test_filter_or_values_milestone() {
    # Match either in-flight or settled milestones
    local output=$(run_ovault "" list objective/milestone --status=in-flight,settled)

    assert_contains "$output" "Active Milestone" "Should include in-flight milestone"
    assert_contains "$output" "Settled Milestone" "Should include settled milestone"
}

# ============================================
# Filter Tests - Negation
# ============================================

test_filter_negation_single() {
    # Exclude settled milestones
    local output=$(run_ovault "" list objective/milestone --status!=settled)

    assert_contains "$output" "Active Milestone" "Should include non-settled milestone"
    # Settled Milestone should be excluded
    if echo "$output" | grep -q "Settled Milestone"; then
        fail "Should NOT include settled milestone"
    fi
}

test_filter_negation_multiple() {
    # Exclude both raw and settled
    local output=$(run_ovault "" list objective/milestone --status!=raw,settled)

    assert_contains "$output" "Active Milestone" "Should include in-flight milestone"
    if echo "$output" | grep -q "Settled Milestone"; then
        fail "Should NOT include settled milestone"
    fi
}

# ============================================
# Filter Tests - Missing/Empty Field
# ============================================

test_filter_field_missing() {
    # Ideas have 'priority' in schema, but fixtures don't set it
    # This tests filtering for empty/missing field values
    local output=$(run_ovault "" list idea --priority=)

    # Both fixture ideas have no priority set (field is missing from frontmatter)
    assert_contains "$output" "Sample Idea" "Should include idea with missing priority"
    assert_contains "$output" "Another Idea" "Should include idea with missing priority"
}

test_filter_field_exists() {
    # Find items where status field has a value (not empty)
    local output=$(run_ovault "" list idea --status!=)

    # Sample Idea has status: raw
    assert_contains "$output" "Sample Idea" "Should include idea with status value"
}

# ============================================
# Filter Tests - AND (multiple filters)
# ============================================

test_filter_and_multiple_fields() {
    # Filter by type AND objective-type
    local output=$(run_ovault "" list objective --type=objective --objective-type=task)

    assert_contains "$output" "Sample Task" "Should include matching task"
    # Should NOT include milestones
    if echo "$output" | grep -q "Milestone"; then
        fail "Should NOT include milestones when filtering for tasks"
    fi
}

test_filter_combined_with_options() {
    # Combine filter with --fields option
    local output=$(run_ovault "" list --fields=status objective/task --status=in-flight)

    assert_contains "$output" "NAME" "Should have table header"
    assert_contains "$output" "STATUS" "Should have STATUS column"
    assert_contains "$output" "Sample Task" "Should include matching task"
    assert_contains "$output" "in-flight" "Should show status value"
}

test_filter_combined_with_paths() {
    # Combine filter with --output paths option
    local output=$(run_ovault "" list --output paths objective/task --status=in-flight)

    assert_contains "$output" "Objectives/Tasks/Sample Task.md" "Should show path for matching task"
}

# ============================================
# Filter Tests - Schema Validation Errors
# ============================================

test_filter_invalid_field_error() {
    local output
    output=$(run_ovault "" list idea --nonexistent=value 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should exit with error for invalid field"
    assert_contains "$output" "Unknown field" "Should report unknown field"
    assert_contains "$output" "Valid fields:" "Should list valid fields"
}

test_filter_invalid_option_value_error() {
    local output
    output=$(run_ovault "" list idea --status=invalid-status 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should exit with error for invalid option value"
    assert_contains "$output" "Invalid value" "Should report invalid value"
    assert_contains "$output" "Valid values:" "Should list valid option values"
}

test_filter_typo_in_field_name() {
    # Common typo: staus instead of status
    local output
    output=$(run_ovault "" list idea --staus=raw 2>&1)
    local exit_code=$?

    assert_equals "1" "$exit_code" "Should exit with error for typo in field name"
    assert_contains "$output" "Unknown field 'staus'" "Should identify the typo"
}

# ============================================
# Filter Tests - Edge Cases
# ============================================

test_filter_parent_type_with_subtype_field() {
    # When listing 'objective', we should be able to filter by fields
    # that only exist in subtypes (like 'milestone' field in tasks)
    local output=$(run_ovault "" list objective --objective-type=task)

    assert_contains "$output" "Sample Task" "Should include task"
    if echo "$output" | grep -q "Milestone"; then
        fail "Should NOT include milestones"
    fi
}

test_filter_empty_result_not_error() {
    # Filtering that matches nothing should return empty, not error
    local output
    output=$(run_ovault "" list objective/task --status=backlog)
    local exit_code=$?

    assert_equals "0" "$exit_code" "Should succeed even with no matches"
    [[ -z "${output// /}" ]] || fail "Output should be empty when no matches"
}
