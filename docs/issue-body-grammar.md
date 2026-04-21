# Issue Body Grammar

Authoritative specification for the issue-body shapes that `sdlc-server`'s
`spec_*` and `epic_*` handlers parse. This document is the contract between
the handlers and the skills/templates that author issues (e.g.
`/devspec upshift`, `/issue`, `docs/devspec-template.md` in
`claudecode-workflow`, and `.gitlab/issue_templates/feature.md` in
downstream projects).

If a template or skill authors issues outside this grammar, the handlers
should be updated to accept the new shape (or the authoring side brought
into the grammar) — NOT left to silently return empty results. Silent empty
is the worst failure mode; every parser in this cluster surfaces a
diagnostic hint (`accepted_sections`, `accepted_headings`, `source`) so
consumers can tell the difference between "no data" and "data present but
shape not recognized."

## Section parsing (shared)

All handlers delegate body parsing to `parseSections` in
`lib/spec_parser.ts`. Only `## H2` headings create sections. H3 and below
are treated as section content. Heading titles are normalized
(`Acceptance Criteria` → `acceptance_criteria`: lowercase, punctuation
stripped, whitespace/hyphens collapsed to `_`).

Content appearing before the first H2 is discarded by the parser. If a
story's structured content needs to be parsed, it must live under an H2
heading.

## spec_validate_structure

Validates that a story issue has the sections an implementing agent needs.

### Required sections

Each canonical key is satisfied by any of its aliases (listed as accepted H2
headings):

| Canonical key | Accepted H2 headings |
|---------------|----------------------|
| `changes` | `## Changes`, `## Implementation Steps` |
| `tests` | `## Tests`, `## Test Procedures` |
| `acceptance_criteria` | `## Acceptance Criteria` |

A section with zero non-whitespace content counts as missing. When any
required section is absent, the response includes an `accepted_headings`
object naming the H2 forms that would have satisfied each missing key.

### Optional sections

| Canonical key | Accepted H2 headings |
|---------------|----------------------|
| `dependencies` | `## Dependencies` |

## epic_sub_issues

Extracts ordered sub-issue references from an epic body.

### Accepted H2 section names

The handler picks the first section whose normalized key matches any of:

- Explicit sub-issue names: `sub_issues`, `subissues`, `children`, `tasks`, `task_list`
- Wave-plan shape: `waves`, `wave_map`, `phases`, `phased_implementation_plan`, `implementation_plan`, `stories`, `backlog`

When no matching section is present, the response includes
`accepted_sections` and `reason` fields so the caller knows what would have
been recognized.

### Content shapes within the section

Tried in order. First one to yield rows wins:

1. **Table with `Order` / `Issue` / `Title` columns.** Column matching is
   case-insensitive substring — `| Order | Issue | Title | Dependencies |`
   works. Each row produces one sub-issue; order comes from the `Order`
   column if present.
2. **Checklist or bullet list.** Each `- [ ]`, `- [x]`, or `- ` line that
   contains a recognized ref produces one sub-issue; order comes from
   position within the section. Works unchanged with H3 wave groupings
   (e.g. `### Wave 1 — Foundation` followed by bullets) — the H3 lines are
   skipped as non-bullets, and the bullets parse correctly.

### Accepted ref forms

- `#N` — resolved to the current repo slug (derived via `git remote`)
- `org/repo#N` — preserved verbatim
- `https://github.com/org/repo/issues/N` or
  `https://gitlab.com/org/repo/-/issues/N` — normalized to `org/repo#N`

## spec_dependencies

Extracts dependency refs from a story body.

### Primary source

The `## Dependencies` H2 section. Content may be a bullet list, table, or
free-form text — the ref-harvesting regexes handle any arrangement.

### Fallback source

When `## Dependencies` is absent or empty, the handler scans every section
for a `**Dependencies:**` bold-label line (e.g. inside a `## Metadata`
section) and harvests refs from its content (up to the next bold label,
next H2, or end of section).

The response's `source` field reports which path was taken:
`dependencies_section`, `bold_label_fallback`, or `none`.

### Accepted ref forms

- `#N` — resolved to the current repo slug
- `org/repo#N`
- Full `github.com` / `gitlab.com` issue URLs
- Literal `None` (case-insensitive, word-anchored) — returns an empty list

## Regression fixtures

`tests/fixtures/parser-grammar/` holds verbatim issue bodies produced by
`/devspec upshift` and `/issue` at the grammar's current acceptance point.
Parser tests assert clean extraction against these fixtures. If the
authoring side changes its output shape, the fixture test fails loudly —
preventing silent downstream empties.

## When to update this document

- Before adding a new accepted section alias: add it here and to the
  handler.
- Before changing an accepted ref form: add a regression test and update
  this document.
- When renaming a canonical key: update here + handler + all referencing
  tool descriptions in one PR. Breaking the grammar is a tracked event,
  not an accident.
