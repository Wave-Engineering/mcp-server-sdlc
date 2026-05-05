/**
 * Regression fixtures for devspec parser bugs.
 *
 * These fixtures are based on patterns observed in real Dev Specs from the
 * blueshift-docmancer-ui project and other Wave Engineering codebases.
 */

/**
 * Fixture demonstrating Bug 1 (Tier 2 blindness).
 *
 * Section 5.A contains TWO tables: one for Tier 1 deliverables and one for
 * Tier 2 deliverables under a `#### Tier 2` sub-heading. The old parser only
 * captured the first table; the new parser captures both.
 */
export const TIER_2_FIXTURE = `# Development Specification

## 5. Detailed Design

### 5.A Deliverables Manifest

This project has both Tier 1 (always-required) and Tier 2 (conditionally-required) deliverables.

#### Tier 1

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | \`README.md\` | Wave 1 | required | Project overview |
| DM-02 | Unified build system | Code | 1 | \`Makefile\` | Wave 1 | required | |
| DM-03 | CI/CD pipeline | Code | 1 | \`.github/workflows/ci.yml\` | Wave 1 | required | |
| DM-04 | Automated test suite | Test | 1 | \`tests/\` | Wave 1 | required | |
| DM-05 | Test results (JUnit XML) | Test | 1 | \`reports/junit.xml\` | Wave 1 | required | |
| DM-06 | Coverage report | Test | 1 | \`reports/coverage.xml\` | Wave 1 | required | |
| DM-07 | CHANGELOG | Docs | 1 | \`CHANGELOG.md\` | Wave 1 | required | |
| DM-08 | VRTM | Trace | 1 | N/A — because the project is a spike | Wave 3 | required | |
| DM-09 | Audience-facing doc (runbook) | Docs | 1 | \`docs/runbook.md\` | Wave 2 | required | |

#### Tier 2

Tier 2 deliverables are triggered by project-specific conditions. In this case, the presence of manual verification procedures (MV-XX items in Section 6.4) triggers the Manual Test Procedures Document requirement.

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-10 | Manual test procedures document | Docs | 2 | \`docs/manual-tests.md\` | Wave 3 | required | Triggered by MV items in Section 6.4 |

## 6. Test Plan

### 6.4 Manual Verification Procedures

| ID | Procedure | Pass Criteria | Req IDs |
|----|-----------|--------------|---------|
| MV-01 | User clicks the "Submit" button | Confirmation dialog appears | R-01 |
| MV-02 | User submits form with empty required fields | Error message displays | R-02 |

## 7. Definition of Done

- [ ] All Phase DoD checklists satisfied
- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified
`;

/**
 * Fixture demonstrating Bug 2 (MV-XX blindness).
 *
 * Section 6.4 contains MV-XX IDs wrapped in bold markdown (**MV-01**). The
 * old parser only recognized plain MV-XX; the new parser recognizes both.
 */
export const BOLD_MV_FIXTURE = `# Development Specification

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | \`README.md\` | Wave 1 | required | |
| DM-09 | Audience-facing doc | Docs | 1 | \`docs/runbook.md\` | Wave 2 | required | |
| DM-10 | Manual test procedures | Docs | 2 | \`docs/manual-tests.md\` | Wave 3 | required | |

## 6. Test Plan

### 6.4 Manual Verification Procedures

Bold-wrapped MV IDs are a common convention in Wave Engineering Dev Specs to visually distinguish them from surrounding prose.

| ID | Procedure | Pass Criteria | Req IDs |
|----|-----------|--------------|---------|
| **MV-01** | User navigates to /dashboard | Dashboard loads within 2 seconds | R-05 |
| **MV-02** | User clicks "Export CSV" button | CSV file downloads | R-06 |
| **MV-03** | User uploads a file larger than 10MB | Error message "File too large" displays | R-07 |

## 7. Definition of Done

- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified
`;

/**
 * Fixture demonstrating Bug 3 (Wave-grouping by wave|deps).
 *
 * Section 8 stories have **Wave:** metadata in the form "N | dep1, dep2" where
 * dependencies are embedded in the same line. The old parser used the entire
 * string as the grouping key; the new parser strips everything after the first
 * `|` and extracts dependencies separately.
 */
export const WAVE_DEPS_FIXTURE = `# Development Specification

## 8. Phased Implementation Plan

### Phase 1: Foundation (Epic)

#### Phase 1 Definition of Done

- [ ] All Wave 1 stories complete
- [ ] CI pipeline green
- [ ] Deliverables DM-01 through DM-04 produced

### Wave Map

Wave 1 establishes the baseline (no dependencies).
Wave 2 builds on Wave 1 (depends on stories 1.1, 1.2).
Wave 3 builds on Wave 2 (depends on stories 2.1, 2.2, 2.3).

#### Story 1.1: Initialize project structure

**Wave:** 1
**Repository:** mcp-server-sdlc
**Dependencies:** None

**Implementation Steps:**

1. Create \`README.md\` with project overview
2. Create \`package.json\` with dependencies
3. Create \`.gitignore\`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_readme_exists\` | Verify README.md exists | \`tests/structure.test.ts\` |

*Integration/E2E Coverage:*

- Repository clones without errors

**Acceptance Criteria:**

- [ ] README.md exists with project overview
- [ ] package.json exists with valid JSON
- [ ] .gitignore exists

#### Story 1.2: Set up CI pipeline

**Wave:** 1
**Repository:** mcp-server-sdlc
**Dependencies:** None

**Implementation Steps:**

1. Create \`.github/workflows/ci.yml\`
2. Add lint job
3. Add test job

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_ci_config_valid\` | Verify CI YAML is valid | \`tests/ci.test.ts\` |

*Integration/E2E Coverage:*

- CI runs on push to main

**Acceptance Criteria:**

- [ ] CI workflow file exists
- [ ] CI runs on push
- [ ] All jobs pass

#### Story 2.1: Implement parser library

**Wave:** 2 | 1.1, 1.2
**Repository:** mcp-server-sdlc
**Dependencies:** 1.1, 1.2

**Implementation Steps:**

1. Create \`lib/devspec-parser.ts\`
2. Implement \`extractSection()\`
3. Implement \`parseManifestTables()\`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_extract_section\` | Verify section extraction | \`lib/devspec-parser.test.ts\` |

*Integration/E2E Coverage:*

- Parser handles real Dev Spec files

**Acceptance Criteria:**

- [ ] Parser library exists
- [ ] extractSection() works
- [ ] parseManifestTables() works

#### Story 2.2: Integrate parser into devspec_finalize

**Wave:** 2 | 1.1, 1.2
**Repository:** mcp-server-sdlc
**Dependencies:** 1.1, 2.1

**Implementation Steps:**

1. Import parser library in \`handlers/devspec_finalize.ts\`
2. Replace inline parsing with library calls
3. Update tests

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_finalize_uses_parser\` | Verify handler uses new parser | \`tests/devspec_finalize.test.ts\` |

*Integration/E2E Coverage:*

- devspec_finalize handler passes all existing tests

**Acceptance Criteria:**

- [ ] Handler imports parser library
- [ ] Handler uses parseManifestTables()
- [ ] All tests pass

#### Story 3.1: Add regression fixtures

**Wave:** 3 | 2.1, 2.2
**Repository:** mcp-server-sdlc
**Dependencies:** 2.1, 2.2

**Implementation Steps:**

1. Create \`lib/devspec-parser-fixtures.ts\`
2. Add TIER_2_FIXTURE
3. Add BOLD_MV_FIXTURE
4. Add WAVE_DEPS_FIXTURE

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_tier2_fixture\` | Verify Tier 2 parsing | \`lib/devspec-parser.test.ts\` |

*Integration/E2E Coverage:*

- Fixtures exercise all three bug scenarios

**Acceptance Criteria:**

- [ ] Fixtures file exists
- [ ] All three fixtures present
- [ ] Tests use fixtures
`;
