# Opencode Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two user-scope opencode skills, `office-hours` and `plan-ceo-review`, based on the approved design and make them discoverable via opencode's global skill loader.

**Architecture:** Keep the implementation minimal: one `SKILL.md` file per skill in `~/.config/opencode/skills/<name>/`. Each skill preserves the core workflow and mode-selection behavior from the approved spec, but omits gstack-specific runtime machinery. Verification uses fresh opencode CLI processes so the current session does not need to hot-reload.

**Tech Stack:** Markdown, YAML frontmatter, opencode global skill discovery, `opencode debug skill`

---

### Task 1: Author `office-hours`

**Files:**
- Create: `/Users/pradeep/.config/opencode/skills/office-hours/SKILL.md`
- Reference: `/Users/pradeep/Code/JapamApp/docs/superpowers/specs/2026-06-15-opencode-office-hours-plan-ceo-review-design.md`
- Test: `opencode debug skill`

- [ ] **Step 1: Record the failing baseline**

Run:

```bash
opencode debug skill | rg "office-hours"
```

Expected: no output and non-zero exit status, proving the skill is not yet discoverable.

- [ ] **Step 2: Create the skill directory**

Run:

```bash
mkdir -p "/Users/pradeep/.config/opencode/skills/office-hours"
```

Expected: directory exists for the skill file.

- [ ] **Step 3: Write the skill file**

Create `/Users/pradeep/.config/opencode/skills/office-hours/SKILL.md` with frontmatter and a workflow that includes all of these points:

```markdown
---
name: office-hours
description: Use when brainstorming a new idea, pressure-testing whether something is worth building, or shaping the best version of a product concept before planning or coding.
---

# Office Hours

## Overview
This is a pre-implementation product thinking skill. It helps the user figure out what they are actually building before any implementation starts.

## When to Use
- New product or feature idea
- "Is this worth building?"
- Early concept shaping before specs or code

## Hard Gate
- Do not write code.
- Do not create an implementation plan.
- Do not silently switch modes.

## Step 1: Inspect Context
- Review the current repo, docs, and recent context before asking deep questions.

## Step 2: Ask for Mode
Ask the user to choose exactly one mode:
- `startup` - pressure-test whether this is worth building
- `builder` - shape the best version of something worth making

Stay in the chosen mode until the user changes it.

## Step 3: Run the Question Loop
- Ask one question at a time.
- Skip questions already answered.
- Default to at most 6 substantive questions before synthesis.

### Startup Mode
Focus on:
- actual user
- current workaround
- pain level
- narrowest wedge
- evidence
- why now

Tone: skeptical, specific, direct.

### Builder Mode
Focus on:
- coolest version
- whoa factor
- fastest lovable version
- nearest alternative
- 10x version
- what to leave out

Tone: generative, opinionated, disciplined.

## Step 4: Present Approaches
Always produce 2-3 approaches with tradeoffs and a recommendation before the final brief.

## Step 5: Write the Final Brief
Use this markdown shape:
- `Mode`
- `What problem are we actually solving?`
- `Who is this for?`
- `What do they do today?`
- `Why this might matter now`
- `Approach options`
- `Recommended direction`
- `Open questions`
- `Next concrete step`
```

- [ ] **Step 4: Verify the skill is discoverable**

Run:

```bash
opencode debug skill | rg "office-hours"
```

Expected: one matching line containing `office-hours`.

- [ ] **Step 5: Verify the file content matches the approved design**

Check that the written skill explicitly includes:

```text
startup
builder
ask one question at a time
2-3 approaches
no code
no implementation plan
```

Expected: all required concepts are present in the skill file.

### Task 2: Author `plan-ceo-review`

**Files:**
- Create: `/Users/pradeep/.config/opencode/skills/plan-ceo-review/SKILL.md`
- Reference: `/Users/pradeep/Code/JapamApp/docs/superpowers/specs/2026-06-15-opencode-office-hours-plan-ceo-review-design.md`
- Test: `opencode debug skill`

- [ ] **Step 1: Record the failing baseline**

Run:

```bash
opencode debug skill | rg "plan-ceo-review"
```

Expected: no output and non-zero exit status, proving the skill is not yet discoverable.

- [ ] **Step 2: Create the skill directory**

Run:

```bash
mkdir -p "/Users/pradeep/.config/opencode/skills/plan-ceo-review"
```

Expected: directory exists for the skill file.

- [ ] **Step 3: Write the skill file**

Create `/Users/pradeep/.config/opencode/skills/plan-ceo-review/SKILL.md` with frontmatter and a workflow that includes all of these points:

```markdown
---
name: plan-ceo-review
description: Use when reviewing an existing plan, spec, or design with a founder-level scope and ambition lens before implementation starts.
---

# Plan CEO Review

## Overview
This is a review-only skill for an existing plan, spec, or design. It challenges ambition, scope, and execution quality before implementation starts.

## When to Use
- "Think bigger"
- "Rethink this plan"
- "Is this ambitious enough?"
- Scope or strategy review before coding

## Hard Gate
- Do not implement.
- Do not silently change scope.
- Do not pretend the plan is ready when key thinking is missing.

## Step 1: Confirm Review Input
Make sure there is a real plan, design, or spec to review. If the problem is still fuzzy, route the user to `office-hours` instead.

## Step 2: Ask for Review Mode
Ask the user to choose exactly one mode:
- `scope-expansion`
- `selective-expansion`
- `hold-scope`
- `scope-reduction`

Stay faithful to the chosen mode unless the user changes it.

## Step 3: Challenge the Framing
Review:
- what problem the plan solves
- whether there is a better wedge
- what leverage already exists
- whether the plan shows more than one approach

Require 2-3 approaches if the plan only presents one path.

## Step 4: Review One Major Issue at a Time
Possible areas:
- ambition and scope
- architecture
- failure modes and edge cases
- testing
- observability
- rollout and risk
- long-term leverage

Any scope change must be an explicit user decision.

## Step 5: Write the Final Review Memo
Use this markdown shape:
- `Review mode`
- `What problem is the plan trying to solve?`
- `What stays in scope`
- `What could expand or shrink`
- `Critical gaps`
- `Failure modes / edge cases`
- `Testing / observability gaps`
- `Accepted or rejected scope changes`
- `Unresolved decisions`
- `Recommended next move`
```

- [ ] **Step 4: Verify the skill is discoverable**

Run:

```bash
opencode debug skill | rg "plan-ceo-review"
```

Expected: one matching line containing `plan-ceo-review`.

- [ ] **Step 5: Verify the file content matches the approved design**

Check that the written skill explicitly includes:

```text
scope-expansion
selective-expansion
hold-scope
scope-reduction
office-hours
no implementation
```

Expected: all required concepts are present in the skill file.

### Task 3: Final User-Scope Verification

**Files:**
- Verify: `/Users/pradeep/.config/opencode/skills/office-hours/SKILL.md`
- Verify: `/Users/pradeep/.config/opencode/skills/plan-ceo-review/SKILL.md`
- Test: `opencode debug skill`

- [ ] **Step 1: Confirm both skill files exist at user scope**

Run:

```bash
ls "/Users/pradeep/.config/opencode/skills/office-hours/SKILL.md" "/Users/pradeep/.config/opencode/skills/plan-ceo-review/SKILL.md"
```

Expected: both paths print successfully.

- [ ] **Step 2: Confirm opencode sees both skills in a fresh process**

Run:

```bash
opencode debug skill | rg "office-hours|plan-ceo-review"
```

Expected: two matching lines, one for each skill.

- [ ] **Step 3: Confirm the global config still resolves cleanly**

Run:

```bash
opencode debug config
```

Expected: resolved config prints successfully without a config validation error.

- [ ] **Step 4: Record the runtime note for the user**

Tell the user:

```text
The skills are installed at user scope. Restart opencode to make them available in the current interactive session.
```

Expected: the user knows a restart is required for the running session to pick up new skills.
