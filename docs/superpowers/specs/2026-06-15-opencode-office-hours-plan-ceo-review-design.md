# Opencode Office Hours and Plan CEO Review Design

## Goal

Create two opencode-native skills inspired by gstack's `office-hours` and
`plan-ceo-review`, preserving their strongest product-thinking behavior while
removing Claude/gstack-specific runtime machinery.

The result should be two lean skills the user can invoke from opencode:

- `office-hours`
- `plan-ceo-review`

## Product Decision

Keep both `office-hours` modes as explicit first-class choices:

- `startup`
- `builder`

When `office-hours` is invoked, it must explicitly ask the user which mode to
use before entering the main questioning flow.

## Design Goals

- Preserve the core judgment and questioning style from the source skills.
- Make the skills feel native to opencode rather than ported line-by-line.
- Keep the workflows strict enough to be useful but small enough to maintain.
- Prevent scope creep by making mode and scope changes explicit.
- Produce clear final artifacts in markdown, not loose conversational drift.

## Non-Goals

- Do not port telemetry, session tracking, artifact sync, or gbrain features.
- Do not port Claude-specific shell preambles or tool-resolution logic.
- Do not embed plan-mode, conductor, vendoring, or routing-injection behavior.
- Do not turn either skill into an implementation or coding workflow.

## Skill 1: `office-hours`

### Purpose

`office-hours` is a pre-implementation thinking skill. It helps the user decide
what they are actually building before any spec, plan, or code is written.

### Invocation Profile

The skill should be discoverable for prompts like:

- "brainstorm this"
- "help me think through this"
- "is this worth building"
- "office hours"
- "I have an idea"

### Entry Behavior

When invoked, the skill should:

1. Inspect lightweight project and conversation context first.
2. Ask the user to choose one mode explicitly:
   - `startup`: pressure-test whether this idea is worth building.
   - `builder`: shape the best version of something worth making.
3. Stay in the selected mode unless the user explicitly changes it.

### Shared Workflow Rules

- Ask one question at a time.
- Skip questions already answered by the user or obvious from context.
- Limit the default questioning loop to 6 substantive questions before
  synthesis unless the user clearly wants deeper exploration.
- If the user is impatient, compress the flow instead of forcing the full loop.
- Do not write code, implementation tasks, or execution plans.

### `startup` Mode

#### Objective

Determine whether the idea has enough real-world pull, wedge, and clarity to
justify further work.

#### Questioning Themes

- Who is the actual user?
- What do they do today instead?
- What pain or limitation exists right now?
- What is the narrowest useful wedge?
- What evidence suggests this matters?
- Why now?

#### Tone

More skeptical and demanding. It should push for evidence and specificity,
without being performatively harsh.

#### Final Artifact

A concise markdown brief with:

- `Mode`
- `What problem are we actually solving?`
- `Who is this for?`
- `What do they do today?`
- `Why this might matter now`
- `Approach options`
- `Recommended direction`
- `Open questions`
- `Next concrete step`

The `startup` version should emphasize demand, wedge, evidence, and distribution
risk.

### `builder` Mode

#### Objective

Shape the most compelling version of an idea that is already directionally
worth making.

#### Questioning Themes

- What is the coolest version of this?
- What would make someone say "whoa"?
- What is the fastest lovable version?
- What existing alternative is closest?
- What is the 10x version?
- What should be intentionally left out for now?

#### Tone

Generative, opinionated, and product-minded. It should hunt for product shape
and delight without losing discipline.

#### Final Artifact

Use the same markdown brief structure as `startup`, but emphasize:

- product shape
- delight
- scope control
- the fastest compelling version

### `office-hours` Hard Rules

- No implementation.
- No silent transition into writing a plan.
- No silent mode switching.
- Always provide 2-3 approaches with tradeoffs and a recommendation before the
  final brief.
- The user decides the final direction.

## Skill 2: `plan-ceo-review`

### Purpose

`plan-ceo-review` is a founder/strategy review skill for an existing plan,
design, or spec. It does not brainstorm from scratch and it does not implement.

### Invocation Profile

The skill should be discoverable for prompts like:

- "think bigger"
- "rethink this plan"
- "strategy review"
- "expand scope"
- "is this ambitious enough"

### Entry Behavior

When invoked, the skill should:

1. Confirm there is an actual plan, design, or spec to review.
2. If the problem is still fuzzy, redirect the user to `office-hours` instead of
   pretending a review can happen.
3. Ask the user to choose an explicit review mode:
   - `scope-expansion`
   - `selective-expansion`
   - `hold-scope`
   - `scope-reduction`
4. Stay faithful to the chosen mode unless the user changes it.

### Review Modes

#### `scope-expansion`

Push ambition up. Surface ways the plan could become materially better if the
user is willing to accept more scope.

#### `selective-expansion`

Keep the current plan as the baseline, but surface optional expansions one by
one so the user can cherry-pick them.

#### `hold-scope`

Treat the current scope as fixed and make it bulletproof. No silent expansion or
reduction.

#### `scope-reduction`

Cut ruthlessly to the minimum version that still achieves the core outcome.

### Core Workflow

1. Read enough context to understand the plan and nearby code/docs.
2. Challenge the framing before reviewing details:
   - what problem is the plan solving?
   - is there a better wedge?
   - what existing leverage already exists?
   - is the current approach the only plausible path?
3. Require 2-3 approaches if the plan only presents one path.
4. Review one major issue at a time.
5. Require explicit user approval for scope changes.
6. Produce a review memo, not a rewritten implementation plan.

### Review Areas

The skill should be able to review across these areas as relevant:

- ambition and scope quality
- architecture and approach quality
- failure modes and edge cases
- testing gaps
- observability gaps
- rollout and risk
- long-term leverage

### Final Artifact

A concise markdown review memo with:

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

### `plan-ceo-review` Hard Rules

- No implementation.
- No silent scope edits.
- No pretending the plan is ready if key thinking is missing.
- One major issue at a time when the review requires a user decision.
- If the underlying problem definition is weak, say so directly and route back
  to `office-hours`.

## Shared Voice And Interaction Style

Both skills should preserve these qualities from the source material:

- direct and opinionated
- concrete, not abstract
- tied to user outcomes rather than architecture purity
- anti-vague and anti-sycophantic
- explicit recommendations with explicit tradeoffs
- user remains in control of final decisions

## Opencode Adaptation Rules

### Preserve

- explicit mode selection at the start of the skill
- one-question-at-a-time workflow
- strong product judgment
- explicit recommendations
- compact final artifacts in markdown

### Drop

- telemetry and analytics
- shell preambles
- gbrain and artifact-sync behavior
- CLAUDE-specific or conductor-specific tool logic
- vendoring, routing injection, or session state plumbing
- persona padding that does not improve the core workflow

## File Layout

The skills should be created at:

- `.opencode/skills/office-hours/SKILL.md`
- `.opencode/skills/plan-ceo-review/SKILL.md`

## Acceptance Criteria

- `office-hours` explicitly asks for `startup` vs `builder` at invocation time.
- `plan-ceo-review` explicitly asks for review mode at invocation time.
- Both skills are concise enough to be maintainable in opencode.
- Neither skill contains gstack-specific runtime machinery.
- Neither skill writes code or silently crosses into implementation behavior.
- Both skills end in a structured markdown artifact instead of drifting into
  generic conversation.
