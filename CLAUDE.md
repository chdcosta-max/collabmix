# CLAUDE.md — Standing Instructions for Mix//Sync

This file is read at the start of every Claude Code session in this
project. The protocols below apply to ALL work unless the user
explicitly overrides them.

## Project Context

Mix//Sync is a real-time collaborative DJ web application. The user
(Chad) is a non-developer founder. Code quality matters but the user
cannot read code deeply — explanations should be in plain English,
not implementation details unless asked.

Production: collabmix.vercel.app
Repo: github.com/chdcosta-max/collabmix.git
Project root: /Users/chad/Desktop/collabmix/
Worktrees ../collabmix-booth and ../collabmix-decks are REFERENCE
ONLY — never modify them.

Primary file edited: src/collabmix-production.jsx

## Required Reading at Session Start

Always read these at the start of any session before doing work:
1. VISION_5.md (canonical product direction)
2. tools/docs/DESIGN_PHILOSOPHY.md (visual and UX principles)
3. This CLAUDE.md file (these protocols)

Read tools/docs/STRATEGIC_ROADMAP.md if the work touches features
or sequencing.

## Investigation-First Protocol

For any bug fix or modification to existing code:

STEP 1 - INVESTIGATE before changing anything.
- Find the relevant code
- Read it thoroughly
- Identify what's happening, not just what's wrong
- Report findings to the user

STEP 2 - PROPOSE a fix architecture.
- Explain the approach in plain English
- Flag tradeoffs and assumptions
- Wait for user approval

STEP 3 - IMPLEMENT only after approval.

Never skip to Step 3 on bug fixes. The user wants to understand the
problem before authorizing changes.

For new features (not bug fixes), Step 1 can be lighter — just
confirm scope and surface assumptions before building.

## Verification Protocol

Before declaring any task complete or pushing to master, produce a
verification report answering:

1. **Build status:** Did `npm run build` succeed? Paste relevant
   output (last 10 lines minimum).

2. **Type check / lint:** Did `npm run typecheck` and `npm run lint`
   pass? (If these scripts don't exist, note that.)

3. **Runtime check:** Did you run the dev server and load the app?
   Did the changed feature load without console errors?

4. **Test data:** Did you exercise the changed code path with real
   or sample data? Describe what you did.

5. **What's verified vs assumed:** Be explicit. "I verified X by
   doing Y. I'm assuming Z works because the architecture is correct
   but I didn't test it."

6. **Known limitations:** Any edge cases the fix doesn't handle?
   Regression risks?

7. **Recommended user verification:** What should the user test on
   their end before trusting this in production? Give a specific,
   actionable checklist.

If any item cannot be completed, state explicitly why and what
would be needed to verify properly.

Never say "this is complete" or "ready to push" without a
verification report. If a task is genuinely unverifiable in
isolation (rare), say so and propose what verification looks like.

## Scope Discipline

Stay focused on the requested task. If you discover related issues
or improvements while working:

- DO NOT silently expand scope to fix them
- DO flag them to the user with a brief note: "While working on X,
  I noticed Y. Want me to handle that here, in a follow-up, or
  ignore?"
- Wait for user direction before expanding scope

Exception: If the requested task literally cannot be completed
without fixing an adjacent issue, fix the minimum needed and clearly
state in the verification report that you did so.

The user's time is best protected by focused work, not heroic
multi-fix sessions.

## No Silent Assumptions

If you have to assume something to proceed, surface the assumption
before acting on it. Examples:

- "I'm assuming the existing color tokens should stay — confirm?"
- "I'm assuming we don't need to support Firefox for this — confirm?"
- "I'm assuming the worktrees stay untouched — confirm?"

A short clarifying question costs minutes. A wrong assumption
costs hours.

When the user is clearly in flow and you must proceed, state the
assumption in your output ("Proceeding under assumption X — let me
know if that's wrong") so it can be caught quickly.

## Commit Message Standards

Every commit message should answer two questions:

1. WHAT changed (the action)
2. WHY it changed (the reason or context)

Format:
"Brief summary in present tense

Longer explanation if needed. Reference the bug, feature, or
session number that motivated this change."

Bad: "Update files"
Good: "Library memory fix: serial decode + 11kHz mono downsample

Reduces per-track transient memory from ~150MB to ~5MB by trimming
to 60s, downsampling to mono 11kHz, and using transferable
postMessage to library worker. Addresses 8GB OOM during analyzeAll
on 100+ track libraries."

Commit in logical chunks, not all-at-once mega-commits, so
individual changes can be reverted if needed.

## Communication Style with Chad

Chad is a non-developer founder. When reporting status:

- Lead with the outcome in plain English ("Memory fix is implemented
  and pushed — should reduce import RAM by ~30x")
- Follow with technical detail only if relevant ("Specifically,
  switched library analysis to streaming decode at 11kHz mono with
  proper transferable buffers")
- Surface tradeoffs and risks proactively
- If something didn't work or was harder than expected, say so
  directly — don't bury bad news in caveats
- Avoid jargon when plain language works
- When asking questions, give 2-4 concrete options with tradeoffs,
  not open-ended "what do you want?"

## Design Philosophy Reference

Mix//Sync follows "Quiet Pro Tool" principles:
- Single accent color: white at varying opacity (0.9 / 0.6 / 0.3)
- Deck colors are the ONLY saturation in the app
- Sentence case typography throughout
- 150ms cubic-bezier transitions on interactive elements
- No glassmorphism, no gradients on backgrounds, no decoration
- Restraint as a virtue

See DESIGN_PHILOSOPHY.md for full details. When making visual
choices, consult that doc, not training-data instincts.

## Critical "Never Do" List

- Never modify ../collabmix-booth or ../collabmix-decks worktrees
- Never delete or rewrite VISION_5.md sections — only append
- Never push without a verification report
- Never expand scope without flagging it first
- Never make visual design decisions without checking
  DESIGN_PHILOSOPHY.md
- Never assume what the user wants — surface assumptions or ask

## Session Handoff Pattern

At the end of every meaningful session, update VISION_5.md with a
dated section documenting:
- What was done (commits, features, fixes)
- What was decided (any new canonical decisions)
- What remains pending

This is how state is preserved across sessions. The next session's
Claude Code reads VISION_5.md and inherits context.

## Session Start Protocol

Required before proposing new features, designs, architecture, or
any new work direction. Tonight's session (May 31, 2026) planned
Phase 3 from scratch without discovering tools/sota-eval/ (47
files of completed analyzer survey work) or tools/bpm-test-harness/
(272-track Rekordbox ground-truth harness). The miss was
expensive — half a session was spent designing a diagnostic that
overlapped with shipped tooling. This protocol prevents the
repeat.

STEP 1 — READ in this order:
1. VISION.md (product vision, if it exists)
2. CLAUDE.md (this file)
3. VISION_5.md — specifically the LAST 2–3 "Session end"
   sections, which carry the most recent state
4. journal.txt if it exists

STEP 2 — INVESTIGATE the repo for prior work on the topic at
hand BEFORE drafting any plan:
- List the tools/ directory
- For each tools/ subdirectory relevant to the topic, read the
  README or status doc (or skim the top-level files)
- Grep for related code patterns in src/

STEP 3 — SEARCH PAST CONVERSATIONS when a search tool is
available:
- The chat-side Claude has a conversation_search tool and should
  use it BEFORE drafting build prompts
- Search for the topic keyword ("analyzer", "beat grid", "library
  import", etc.) before assuming the work is fresh
- When the user says "we've done this before" OR "we've never
  done this," ALWAYS verify against artifacts (repo + past
  chats). Don't take either claim at face value.

STEP 4 — REPORT what was found BEFORE proposing anything:
- "I read X, Y, Z. I found A, B, C in tools/. The relevant prior
  work is..."
- Only THEN propose next steps.

STEP 5 — NEVER propose a build plan that duplicates existing
tools/ work without explicitly addressing why a new path is
better than extending the existing one.

## Visual Verification Protocol

When the session touches UI behavior, audio analysis, waveform
inspection, beat-grid alignment, deck behavior, library
interactions, or anything visual:

- Use Claude Desktop (the Chrome extension) for verification
  rather than relying on the user to eyeball and report in text.
- Claude Desktop produces structured visual evidence
  (screenshots, console capture, DOM inspection) that pure
  text-based feedback loops miss.
- The May 17–21 analyzer sessions ran without this loop and
  missed per-track visual data that was easy to capture once
  the May 31 session used Claude Desktop properly.

If the chat-side Claude finds itself asking the user to paste
JavaScript into console, take screenshots manually, or report
on visual states in text, STOP — that work should be driven by
Claude Desktop instead.
