# Mix//Sync — Social & Matchmaking Design Philosophy

> **🧭 FOUNDATIONAL — read this BEFORE designing any social, matchmaking, community,
> profile, discovery, or taste/preference/comparison feature.** Same tier as
> `DESIGN_PHILOSOPHY.md` (visual/UX) and `WAVEFORM_LOCKED.md` — load-bearing, not optional.
> This is NOT a feature note; it is the principle that drives social-feature decisions. If a
> feature touches another person's taste, it is governed by this doc.
>
> _(Assembled June 26, 2026 from Chad's stated principle. If a canonical
> `mixsync-social-design-philosophy.md` draft exists, swap the body in — the axiom, the
> three-level harm, and the rules below are the binding part.)_

## The core axiom: music taste is identity

A DJ's taste isn't a preference — it's **who they are**. Every social interaction in
Mix//Sync is, underneath, an interaction about identity. That single fact decides
everything below.

## The principle: pair around SHARED taste, never across difference

- **Connect people around what they SHARE** (taste, sound, tempo world, genre) →
  connection, recognition, belonging: *"you get it too."* This is the good experience, and
  it IS the product.
- **Never pair people ACROSS taste differences.**

Taste-matching is **NOT a filter bolted onto matchmaking — it IS the thing that makes the
core experience good.** Matchmaking is *social compatibility*, not just a preference filter.
The magic of collaborative DJing happens when two people's sounds complement each other.

## Why incompatible-taste matching is harmful — three stacking levels

1. **Musical** — the mix literally doesn't work (different genres, tempos, keys, styles).
2. **Experiential** — bad first experiences; friction, not fun.
3. **Social** — difference in taste, framed socially, triggers **judgment**: *"my taste is
   better,"* defensiveness, conflict. You're not critiquing a setting; you're critiquing
   someone's identity.

These stack. Any one is reason enough; together they make "match with anyone" a reliable
way to manufacture the bad experience.

## Design rules

**DO**
- Match only **compatible** taste. Connection/belonging is the goal.
- Frame discovery as *"people who play your sound"* — shared-world belonging.
- Convey match strength through **concrete shared evidence** (shared artists, labels, tempo
  range, genre world) — recognition, not a metric.

**DON'T**
- ❌ **No "match with anyone" / random pairing.** It manufactures the bad experience and
  dilutes the differentiator. (Cut June 2026.)
- ❌ **Never QUANTIFY or RANK taste.** No dating-app "92% match" compatibility score, no
  "in-tune" meter, no taste percentage/ranking. (Cut.) A number turns identity into a
  contest — it invites comparison and judgment, the exact opposite of belonging. Show the
  shared evidence; never the score.
- ❌ **No "live network" implication** before the network is real (the honesty issue the
  "anyone" demo created).

## What this has already decided
- **Removed "Match with anyone."** Matchmaking connects only compatible taste.
- **Cut the "92% match" compatibility score and the "in-tune" meter.** Taste is never
  reduced to a number.

## Before building ANY social feature — ask
1. Does this connect people around what they **share**, or expose a **difference**?
2. Could it make a user feel **judged, ranked, or "lesser"** about their taste? → redesign.
3. Am I **quantifying/ranking** taste? → stop. Surface concrete shared evidence, not a score.
4. Does it imply a **network/liquidity that doesn't exist yet**? → don't.

## Scope — what triggers reading this
Anything involving: matchmaking, community, the feed, profiles, discovery, taste/genre/
preference display, compatibility, comparison, ranking, "who should I play with."

> **Differentiator note:** this is also our positioning. We are the tool that pairs people
> who **play your sound** — not a generic "pair random DJs" app. The philosophy and the moat
> are the same thing. `SOCIAL_VISION.md` (community/matchmaking roadmap) is governed by this.
