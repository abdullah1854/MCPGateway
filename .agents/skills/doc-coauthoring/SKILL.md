---
name: doc-coauthoring
description: Collaborative document writing with structured workflow. Activates for "write document", "draft proposal", "create spec", "documentation", "co-author", "help me write", "RFC", "design doc".
allowed-tools: [Read, Write, Edit, Task, AskUserQuestion]
---

# Document Co-Authoring Skill

## When This Skill Activates
- "Write a document", "draft a proposal"
- "Create a spec", "design document"
- "Help me write", "co-author"
- "RFC", "ADR", "technical spec"
- "Documentation", "user guide"

## Three-Stage Workflow

### Stage 1: Context Gathering

**Start with meta-context questions:**
1. Who is the audience?
2. What's the purpose/goal?
3. What decisions need to be made?
4. What constraints exist?
5. What's the deadline/urgency?

**Then info dump:**
- Ask user to share all relevant context
- Notes, prior docs, requirements
- Stakeholder preferences
- Examples of similar docs they like

**Clarifying questions:**
- Ask 3-5 targeted questions
- Ensure understanding before drafting
- Surface hidden assumptions

### Stage 2: Section-by-Section Drafting

For each section:

```
1. ASK clarifying questions for this section
2. BRAINSTORM 5-20 options/approaches
3. CURATE down to best options
4. DRAFT the section
5. REFINE based on feedback
```

**Feedback guidance:**
- "Specific feedback helps!" not just "looks good"
- "What's missing?" "What's confusing?"
- "What would [stakeholder] push back on?"

**Surgical edits:**
- Never reprint entire sections
- Use targeted replacements
- Preserve voice and flow

### Stage 3: Reader Testing

**Fresh perspective test:**
1. Imagine a reader with NO context
2. Can they answer key questions?
3. Are there gaps or ambiguities?
4. What questions would they ask?

**Predicted questions:**
```markdown
Q: What problem does this solve?
A: [Answer from doc - check clarity]

Q: Why this approach vs alternatives?
A: [Answer from doc - check completeness]

Q: What are the risks?
A: [Answer from doc - check thoroughness]
```

## Document Templates

### Technical Spec / RFC

```markdown
# [Feature Name] - Technical Specification

## Status
Draft | Review | Approved | Implemented

## Summary
[1-2 sentence overview]

## Background
[Context and problem statement]

## Goals
- [Goal 1]
- [Goal 2]

## Non-Goals
- [What this does NOT address]

## Proposed Solution
[Detailed description]

### Architecture
[Diagrams, components, data flow]

### API Changes
[Endpoints, schemas, breaking changes]

## Alternatives Considered
### Option A: [Name]
- Pros: [...]
- Cons: [...]

### Option B: [Name]
- Pros: [...]
- Cons: [...]

## Security Considerations
[Auth, data protection, attack vectors]

## Testing Plan
[How to verify correctness]

## Rollout Plan
[Phased rollout, feature flags, rollback]

## Open Questions
- [ ] [Question 1]
- [ ] [Question 2]
```

### Architecture Decision Record (ADR)

```markdown
# ADR-[NUMBER]: [Title]

## Status
Proposed | Accepted | Deprecated | Superseded

## Context
[What is the issue motivating this decision?]

## Decision
[What is the change being proposed?]

## Consequences
### Positive
- [Benefit 1]
- [Benefit 2]

### Negative
- [Tradeoff 1]
- [Tradeoff 2]

### Neutral
- [Observation 1]

## Alternatives Considered
[Other options and why not chosen]
```

### Project Proposal

```markdown
# [Project Name] Proposal

## Executive Summary
[2-3 sentences for decision makers]

## Problem Statement
[What pain point are we addressing?]

## Proposed Solution
[High-level approach]

## Success Metrics
| Metric | Current | Target |
|--------|---------|--------|
| [Metric 1] | X | Y |

## Timeline
| Phase | Deliverable | Date |
|-------|-------------|------|
| Phase 1 | MVP | Week 2 |

## Resources Required
- Engineering: [X weeks]
- Design: [Y weeks]
- Other: [...]

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk 1] | High | [Plan] |

## Appendix
[Supporting details, research, data]
```

## Writing Principles

### Voice & Tone
- Match audience expectations
- Consistent throughout
- Active voice preferred
- Concise > verbose

### Structure
- Clear hierarchy (H1 → H2 → H3)
- Parallel structure in lists
- One idea per paragraph
- Transitions between sections

### Visuals
- Tables for comparisons
- Diagrams for architecture
- Flowcharts for processes
- Screenshots for UI

## Common Issues

| Issue | Solution |
|-------|----------|
| Too vague | Add concrete examples |
| Too detailed | Move to appendix |
| Missing context | Add Background section |
| No clear ask | Add explicit Proposal |
| Buried conclusion | Lead with Summary |

## Output Format

```markdown
## Document: [Title]

### Stage: [1-Context | 2-Drafting | 3-Review]

### Current Section
[Section being worked on]

### Questions for You
1. [Question 1]
2. [Question 2]

### Draft
[Current draft content]

### Feedback Requested
- Is the tone right?
- What's missing?
- Any concerns?
```
