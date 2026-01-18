---
name: deep-thinking
description: Activates extended reasoning for complex problems. Use when asked to "think harder", "ultrathink", "think deeply", "analyze thoroughly", or when facing architecture decisions, complex debugging, system design, or trade-off analysis.
allowed-tools: [Read, Grep, Glob, Task, TodoWrite]
---

# Deep Thinking Protocol

## When This Skill Activates
- User says "think harder", "ultrathink", "think step by step", "think deeply"
- Complex architecture or system design questions
- Debugging that requires root cause analysis
- Trade-off analysis between multiple approaches
- Code review requiring security/performance deep dive
- Any problem with multiple valid solutions

## Extended Reasoning Process

### Phase 1: Problem Decomposition
Before answering, break the problem into components:
1. What is the core question being asked?
2. What are the constraints (performance, security, maintainability)?
3. What context do I need that I don't have?
4. What assumptions am I making?

### Phase 2: Multi-Path Analysis
For each viable approach:
1. **Describe the approach** in 2-3 sentences
2. **Pros**: What makes this approach good?
3. **Cons**: What are the downsides or risks?
4. **When to use**: Under what conditions is this best?

### Phase 3: Edge Case Hunting
Actively look for:
- What happens with empty/null inputs?
- What happens at scale (1M+ records)?
- What happens with concurrent access?
- What happens when dependencies fail?
- What are the security implications?

### Phase 4: Recommendation
Provide a clear recommendation with:
1. The chosen approach and why
2. Key implementation steps
3. What to watch out for
4. How to validate it works

## Self-Critique Loop
After initial analysis, critique your own thinking:
- Did I consider all stakeholders?
- Am I biased toward familiar solutions?
- What would a senior engineer challenge here?
- Is there a simpler solution I overlooked?

## Output Format
```
## Analysis: [Problem Title]

### Understanding
[Restate the problem to confirm understanding]

### Approaches Considered
1. **[Approach A]**: [Brief description]
   - Pros: ...
   - Cons: ...

2. **[Approach B]**: [Brief description]
   - Pros: ...
   - Cons: ...

### Edge Cases & Risks
- [Edge case 1]: [How to handle]
- [Edge case 2]: [How to handle]

### Recommendation
[Clear recommendation with reasoning]

### Implementation Steps
1. [Step 1]
2. [Step 2]
...

### Validation
[How to verify the solution works]
```

## Key Principle
Take the time to think thoroughly. A well-reasoned 2-minute response beats a rushed 10-second response that misses critical issues.
