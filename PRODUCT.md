# PRODUCT.md

What RedBroccoli is for and the product principles that UI decisions follow.
The visual system is in [DESIGN.md](DESIGN.md), the code structure in
[docs/architecture.md](docs/architecture.md).

## Product

RedBroccoli turns the YouTube lecture you are watching into a study concept
map (terms, definitions, prerequisites, timestamps) in Chrome's side panel,
using an AI provider with the user's own API key.

## Users

Students and self-learners watching long lectures. Not developers: an API key
is a chore they put up with, not something they understand or want to
manage.

## Settings page: user context

The user arrives at Settings with **one goal: connect at least one working AI
provider and get back to the lecture.** Usually they were sent there by the
side panel ("add a key in Settings"), with a key copied from a provider's
console in another tab.

They paste, see that it works, and leave. Nothing that comes after the key
field should depend on them reading it first.

## Principles

1. **Settings are saved predictably. User changes are never lost.**
   Every change is persisted on its own; there is no Save step to forget.
   Closing the tab at any moment keeps what was typed. A failed write is
   said out loud ("Not saved · Retry"), never silent.
2. **Every state has a way forward (no dead ends).** A provider that can't be
   used says why in one word and offers the one action that fixes it: Off
   (tick it), Key missing (paste one / "Add it under Gemini"), Needs access
   ("Allow access & test").
3. **One status per thing.** A provider row shows one readiness word, not a
   row of badges. Save feedback is transient and appears only where the user
   just acted.
4. **Show the next step, fold the rest.** Providers are collapsed to one line;
   the one a new user needs (Gemini) opens on first visit. The free,
   most-used providers (Gemini, Groq, Mistral) come first.
5. **Plain words, few of them.** Provider notes are fragments ("Free · small
   daily quota"), not sentences. Legal or privacy text stays complete but
   visually quiet.
6. **The user's data stays theirs.** Keys stay local and unsynced, and the
   page says so next to the key fields.

## Anti-patterns to reject in review

- A global Save button, or any change that only persists after a later click.
- Status-chip soup: several badges on one row ("paid", "access on Save", …).
- A state with no action next to it (e.g. "access missing" with nothing to
  click).
- Expanding every provider by default, or explanatory paragraphs above the
  fields.
