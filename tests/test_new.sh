#!/bin/zsh

# Test cases for pika.sh
# These are sourced by test_runner.sh

# ============================================
# Schema Validation Tests
# ============================================

test_jq_dependency() {
    # Test that jq is available
    command -v jq &> /dev/null
}

test_schema_file_exists() {
    assert_file_exists "$TEST_SCHEMA" "Schema file should exist"
}

test_schema_valid_json() {
    jq empty "$TEST_SCHEMA" 2> /dev/null
}

test_help_flag() {
    local output=$(run_pika "" help)
    assert_contains "$output" "Usage:" "Help should show usage"
    assert_contains "$output" "edit" "Help should mention edit mode"
}

# ============================================
# Type Discovery Tests
# ============================================

test_get_type_families() {
    local types=$(jq -r '.types | keys[]' "$TEST_SCHEMA")
    assert_contains "$types" "objective" "Should have objective type"
    assert_contains "$types" "idea" "Should have idea type"
    assert_contains "$types" "entity" "Should have entity type"
}

test_get_subtypes() {
    local subtypes=$(jq -r '.types.objective.subtypes | keys[]' "$TEST_SCHEMA")
    assert_contains "$subtypes" "task" "Should have task subtype"
    assert_contains "$subtypes" "milestone" "Should have milestone subtype"
}

# ============================================
# File Creation Tests
# ============================================

test_create_idea() {
    # Input: select idea type (2), enter name, skip status (enter), skip priority (enter)
    # Type order in test schema: entity, idea, objective (alphabetical from jq)
    local input="2\nTest Idea\n\n"
    run_pika "$input" new > /dev/null 2>&1

    assert_file_exists "$TEST_VAULT/Ideas/Test Idea.md" "Idea file should be created"
    assert_file_contains "$TEST_VAULT/Ideas/Test Idea.md" "type: idea" "Should have type frontmatter"
}

test_create_task_with_defaults() {
    # Input: select objective (3), select task (1), enter name, skip status, skip milestone, skip deadline, skip steps
    local input="3\n2\nMy Test Task\n\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Tasks/My Test Task.md"
    assert_file_exists "$file" "Task file should be created"
    assert_file_contains "$file" "type: objective" "Should have type"
    assert_file_contains "$file" "objective-type: task" "Should have objective-type"
    assert_file_contains "$file" "## Steps" "Should have Steps section"
    assert_file_contains "$file" "## Notes" "Should have Notes section"
}

test_create_milestone() {
    # Input: select objective (3), select milestone (1), enter name, skip status
    local input="3\n1\nTest Milestone\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Milestones/Test Milestone.md"
    assert_file_exists "$file" "Milestone file should be created"
    assert_file_contains "$file" "type: objective"
    assert_file_contains "$file" "objective-type: milestone"
    assert_file_contains "$file" "## Tasks"
}

test_create_person() {
    # Input: select entity (1), select person (1), enter name
    local input="1\n1\nJohn Doe\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Entities/People/John Doe.md"
    assert_file_exists "$file" "Person file should be created"
    assert_file_contains "$file" "type: entity"
    assert_file_contains "$file" "entity-type: person"
}

test_create_with_direct_type() {
    # Create idea directly without interactive type selection
    # Input: name, skip status, skip priority
    local input="Direct Idea\n\n\n"
    run_pika "$input" new idea > /dev/null 2>&1

    assert_file_exists "$TEST_VAULT/Ideas/Direct Idea.md" "Direct type creation should work"
}

# ============================================
# Frontmatter Tests
# ============================================

test_static_value_now() {
    # Create task and check creation-date has $NOW format
    local input="3\n2\nTimestamp Task\n\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Tasks/Timestamp Task.md"
    # Check for date format YYYY-MM-DD HH:MM
    assert_file_contains "$file" "creation-date: 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]" "Should have creation date"
}

test_enum_selection() {
    # Create idea with specific status selection
    # Input: select idea (2), name, select "backlog" (2), skip priority
    local input="2\nEnum Test\n2\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Ideas/Enum Test.md"
    assert_file_contains "$file" "status: backlog" "Should have selected status"
}

test_enum_default() {
    # Create idea skipping status (should use default "raw")
    local input="2\nDefault Test\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Ideas/Default Test.md"
    assert_file_contains "$file" "status: raw" "Should use default status"
}

test_input_field() {
    # Create task with deadline input
    # Input: select objective (3), select task (2), name, skip status, skip milestone, enter deadline, skip steps
    local input="3\n2\nDeadline Task\n\n\n2024-12-31\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Tasks/Deadline Task.md"
    assert_file_contains "$file" "deadline: 2024-12-31" "Should have deadline"
}

test_frontmatter_order() {
    # Verify frontmatter fields are in correct order
    local input="2\nOrder Test\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Ideas/Order Test.md"
    local content=$(cat "$file")

    # Check order: type comes before status
    local type_line=$(grep -n "^type:" "$file" | cut -d: -f1)
    local status_line=$(grep -n "^status:" "$file" | cut -d: -f1)

    [[ $type_line -lt $status_line ]]
}

# ============================================
# Dynamic Source Tests
# ============================================

test_dynamic_source_filters() {
    # The fixture has "Active Milestone" (in-flight) and "Settled Milestone" (settled)
    # Dynamic source should only show Active Milestone

    # Query dynamic source manually
    local active_count=$(ls "$TEST_VAULT/Objectives/Milestones"/*.md | while read f; do
        local file_status=$(awk -F': ' '$1=="status"{print $2}' "$f")
        [[ "$file_status" != "settled" ]] && echo "$f"
    done | wc -l | tr -d ' ')

    assert_equals "1" "$active_count" "Should filter out settled milestones"
}

# ============================================
# Body Section Tests
# ============================================

test_body_section_heading_levels() {
    local input="3\n2\nHeading Test\n\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Tasks/Heading Test.md"
    assert_file_contains "$file" "^## Steps" "Should have level 2 heading"
    assert_file_contains "$file" "^## Notes" "Should have level 2 heading"
}

test_no_body_sections() {
    # Person entity has no body sections
    local input="1\n1\nNo Body Person\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Entities/People/No Body Person.md"
    local body=$(awk 'BEGIN{p=0; c=0} /^---$/{c++; if(c==2){p=1; next}} p{print}' "$file")

    # Body should be empty or just whitespace
    [[ -z "${body// /}" ]]
}

# ============================================
# Edit Mode Tests
# ============================================

test_edit_mode_file_not_found() {
    run_pika_expect_fail "" edit "nonexistent.md" > /dev/null 2>&1
}

test_edit_mode_preserves_body() {
    # Create a file first
    local input="2\nEdit Target\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Ideas/Edit Target.md"

    # Add custom content to body
    echo -e "\n## Custom Section\nMy custom content" >> "$file"

    # Edit the file (skip all prompts)
    local edit_input="\n\n\n\n"
    echo "$edit_input" | "$PIKA_SH" --vault="$TEST_VAULT" edit "Ideas/Edit Target.md" > /dev/null 2>&1

    # Verify custom content preserved
    assert_file_contains "$file" "Custom Section" "Custom section should be preserved"
    assert_file_contains "$file" "My custom content" "Custom content should be preserved"
}

# ============================================
# Error Handling Tests
# ============================================

test_missing_schema_file() {
    # Remove schema and verify error
    rm "$TEST_SCHEMA"
    run_pika_expect_fail "" new > /dev/null 2>&1
}

test_no_type_selected() {
    # Just press enter without selecting (should fail)
    run_pika_expect_fail "\n" new > /dev/null 2>&1
}

test_file_overwrite_protection() {
    # Create a file
    local input="2\nDuplicate Test\n\n\n"
    run_pika "$input" new > /dev/null 2>&1

    # Try to create same file, decline overwrite (n)
    local input2="2\nDuplicate Test\n\n\nn\n"
    local output=$(run_pika "$input2" new 2>&1 || true)

    assert_contains "$output" "already exists" "Should warn about existing file"
}

# ============================================
# Integration Tests
# ============================================

test_full_task_workflow() {
    # Create a complete task with all fields filled
    # Input: objective (3), task (2), name, status=in-flight (3), milestone (1=Active Milestone), deadline, steps
    local input="3\n2\nIntegration Task\n3\n1\n2024-12-25\nStep 1, Step 2\n"
    run_pika "$input" new > /dev/null 2>&1

    local file="$TEST_VAULT/Objectives/Tasks/Integration Task.md"

    assert_file_exists "$file"
    assert_file_contains "$file" "type: objective"
    assert_file_contains "$file" "objective-type: task"
    assert_file_contains "$file" "status: in-flight"
    assert_file_contains "$file" 'milestone: "\[\[Active Milestone\]\]"'
    assert_file_contains "$file" "deadline: 2024-12-25"
    assert_file_contains "$file" "## Steps"
}
