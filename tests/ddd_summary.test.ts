import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/ddd_summary.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempFile(content: string): Promise<string> {
  const path = `/tmp/ddd-summary-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

// A complete Domain Model fixture with every section populated. Counts:
//   events      = 5 (E-01..E-05 across two phases)
//   commands    = 3 (C-01..C-03)
//   actors      = 3 rows in the Responsibility Matrix
//   policies    = 6 (P-01..P-06 spread across cascade/quality/notification/loop)
//   aggregates  = 2 (#### Script, #### Project) under 7.1
//   read_models = 4 (RM-01..RM-04 across two actor subsections)
const COMPLETE_MODEL = `# Sample Project — Domain Model

**Method:** Event Storming (Domain-Driven Design)
**Status:** Draft

---

## 1. Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| D-01 | Use EventStorming | Shared understanding |

---

## 2. Domain Context

### 2.1 Project Overview

Modeling a content pipeline.

### 2.2 Actors

| Actor | Type | Description |
|-------|------|-------------|
| Director | Human | Creative lead |
| Agent | Agent | Automation |

### 2.3 Core Problem

Too slow.

---

## 3. Domain Events

### Phase: Ideation

| # | Event | Notes |
|---|-------|-------|
| E-01 | Brief Submitted | Kickoff event |
| E-02 | Brief Approved | After review |

### Phase: Production

| # | Event | Notes |
|---|-------|-------|
| E-03 | Script Drafted | First draft |
| E-04 | Script Reviewed | Feedback gathered |
| E-05 | Script Approved | Ready for production |

**Total events:** 5

---

## 4. Commands

| # | Command | Serial Chain | Decision |
|---|---------|--------------|----------|
| C-01 | Submit Brief | E-01 | Human initiates |
| C-02 | Approve Brief | E-02 | Director approves |
| C-03 | Draft Script | E-03 -> E-04 -> E-05 | Agent chain |

**Total commands:** 3

### Key Insights

- **Approval gates:** C-02
- **Agent-autonomous chains:** C-03

---

## 5. Actors

### Responsibility Matrix

| Actor | Commands | Responsibility |
|-------|----------|---------------|
| **Director** | C-02 | Approves briefs |
| **Producer** | C-01 | Submits briefs |
| **Agent** | C-03 | Drafts scripts |

### Actor Pattern Summary

| Actor Type | Commands | Count |
|-----------|----------|:-----:|
| **Human only** | C-01, C-02 | 2 |
| **Agent only** | C-03 | 1 |

**The split:** Humans decide, agents execute.

---

## 6. Policies

### 6.1 Cascade Policies (Dominos)

| # | When | Then | Why Automatic |
|---|------|------|---------------|
| P-01 | E-02 | Trigger C-03 | Always chain |
| P-02 | E-05 | Trigger downstream | Always chain |

### 6.2 Quality Policies (Guardrails)

| # | When | Then | Why |
|---|------|------|-----|
| P-03 | E-03 without citation | Reject | Must cite |

### 6.3 Notification Policies (Alerts)

| # | When | Then | Channel |
|---|------|------|---------|
| P-04 | E-02 | Notify Director | Discord |
| P-05 | E-05 | Notify Producer | Discord |

### 6.4 Loop Policies (Iteration)

| # | When | Then | Exit Condition |
|---|------|------|----------------|
| P-06 | E-04 rejected | Redraft | Approved |

**Total policies:** 6

### Key Insights

- **Critical cascades:** P-01 triggers the production chain.

---

## 7. Aggregates

### 7.1 Core Aggregates

#### Script (Root Aggregate)

**What it holds:** Text and metadata.

**State machine:**
- **States:** draft | reviewed | approved
- **Transitions:** E-03 (draft), E-04 (reviewed), E-05 (approved)

**Invariants:**
- Cannot approve without review

---

#### Project

**What it holds:** High-level campaign data.

**State machine:**
- **States:** planning | active | closed

### 7.2 Aggregate Relationships

\`\`\`
Project
 └── Script (1:many)
\`\`\`

### 7.3 Aggregate Homes in Monorepo

| Aggregate | Location | Notes |
|-----------|----------|-------|
| Script | repo/scripts | filesystem |

---

## 8. Read Models

### 8.1 For Director

| # | Read Model | Informs Decision | Shows |
|---|-----------|-----------------|-------|
| RM-01 | Brief Queue | C-02 approval | Pending briefs |
| RM-02 | Script Review Board | C-02 approval | Scripts needing review |

### 8.2 For Agent

| # | Read Model | Informs Decision | Shows |
|---|-----------|-----------------|-------|
| RM-03 | Draft Queue | C-03 drafting | Scripts to draft |
| RM-04 | Feedback Log | C-03 revision | Reviewer comments |

**Total read models:** 4

---

## 9. Open Questions

1. **How to version scripts?**

---

## 10. DDD -> Dev Spec Translation Map

| DDD Artifact | Dev Spec Section | Translation | Status |
|--------------|-------------|-------------|:------:|
| Actors | 1.4 Target Users | Personas | Pending |
`;

describe('ddd_summary handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('ddd_summary');
    expect(typeof handler.execute).toBe('function');
    expect(typeof handler.description).toBe('string');
  });

  test('counts all structural elements in a complete domain model', async () => {
    const path = await writeTempFile(COMPLETE_MODEL);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.events).toBe(5);
    expect(parsed.commands).toBe(3);
    expect(parsed.actors).toBe(3);
    // P-01..P-06 across cascade, quality, notification, loop subsections.
    expect(parsed.policies).toBe(6);
    // Script + Project (h4 headings under 7.1).
    expect(parsed.aggregates).toBe(2);
    // RM-01..RM-04 across 8.1 and 8.2.
    expect(parsed.read_models).toBe(4);
  });

  test('handles missing sections gracefully — counts are 0', async () => {
    const md = `# Minimal model

## 1. Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| D-01 | Foo | Bar |

## 2. Domain Context

Context only.

## 9. Open Questions

1. None.
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.events).toBe(0);
    expect(parsed.commands).toBe(0);
    expect(parsed.actors).toBe(0);
    expect(parsed.policies).toBe(0);
    expect(parsed.aggregates).toBe(0);
    expect(parsed.read_models).toBe(0);
  });

  test('counts policies across multiple subsections (cascade, quality, notification, loop)', async () => {
    const md = `# Model

## 6. Policies

### 6.1 Cascade Policies

| # | When | Then | Why |
|---|------|------|-----|
| P-01 | E-01 | Trigger C-02 | always |
| P-02 | E-02 | Trigger C-03 | always |
| P-03 | E-03 | Trigger C-04 | always |

### 6.2 Quality Policies

| # | When | Then | Why |
|---|------|------|-----|
| P-04 | Bad input | Reject | safety |
| P-05 | Missing ref | Log | trace |

### 6.3 Notification Policies

| # | When | Then | Channel |
|---|------|------|---------|
| P-06 | E-05 | Notify | Discord |

### 6.4 Loop Policies

| # | When | Then | Exit |
|---|------|------|------|
| P-07 | E-06 | Continue | Approved |
| P-08 | E-07 | Continue | Max attempts |

### Key Insights

- P-01, P-02 are critical cascades.
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    // 8 unique P-IDs even though P-01/P-02 are mentioned again in Key Insights.
    expect(parsed.policies).toBe(8);
  });

  test('counts aggregates as h4 headings under Section 7', async () => {
    const md = `# Model

## 7. Aggregates

### 7.1 Core Aggregates

#### Alpha (Root Aggregate)

Details.

#### Bravo

Details.

#### Charlie

Details.

#### Delta

Details.

### 7.2 Aggregate Relationships

Diagram stuff — this h3 should NOT count.

### 7.3 Aggregate Homes

More h3 — should NOT count.

## 8. Read Models

None.
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.aggregates).toBe(4);
  });

  test('counts actors from the Responsibility Matrix and ignores the Pattern Summary', async () => {
    const md = `# Model

## 5. Actors

### Responsibility Matrix

| Actor | Commands | Responsibility |
|-------|----------|---------------|
| **Alpha** | C-01 | Role A |
| **Bravo** | C-02 | Role B |
| **Charlie** | C-03 | Role C |
| **Delta** | C-04 | Role D |
| **Echo** | C-05 | Role E |

### Actor Pattern Summary

| Actor Type | Commands | Count |
|-----------|----------|:-----:|
| Human only | C-01, C-02 | 2 |
| Agent only | C-03, C-04, C-05 | 3 |
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    // Only the Responsibility Matrix (first table) counts: 5 rows.
    expect(parsed.actors).toBe(5);
  });

  test('counts events uniquely across multiple phases', async () => {
    const md = `# Model

## 3. Domain Events

### Phase: Alpha

| # | Event | Notes |
|---|-------|-------|
| E-01 | Start | - |
| E-02 | Middle | - |

### Phase: Bravo

| # | Event | Notes |
|---|-------|-------|
| E-03 | Continue | - |
| E-04 | Almost | - |

### Phase: Charlie

| # | Event | Notes |
|---|-------|-------|
| E-05 | Done | references E-01 as trigger |

**Total events:** 5
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    // E-01 is mentioned twice but must only count once.
    expect(parsed.events).toBe(5);
  });

  test('returns ok:false when file is missing', async () => {
    const result = await handler.execute({
      path: '/tmp/ddd-summary-nonexistent-xyz-99999.md',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('schema validation rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema validation rejects empty path', async () => {
    const result = await handler.execute({ path: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
