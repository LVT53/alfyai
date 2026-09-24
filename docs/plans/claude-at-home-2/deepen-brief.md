# Feature 2 — the deepening brief

The seven slice specs are written and reviewed. This pass makes each one **executable by a dev agent
without further questions**. One agent per slice, deepening that slice file only.

## Rules

- **Apply `decisions.md` (rulings 1–12).** If your slice contradicts a ruling, fix the slice, not the ruling.
- **Edit only your own slice file.** Never touch another `slice-*.md`, `plan.md`, `decisions.md`, the parent
  spec or any code. Cross-slice problems are **reported**, not fixed by you.
- **Docs only.** No code, no commits, no test runs that change state.
- **Verify before asserting.** Any claim about the repo (a file exists, a symbol is exported, a test pins a
  path, a package is installed) must be checked by reading the code, and named as `path:line`. If you cannot
  verify it, mark it unverified — do not paper over it.
- **Keep what is already right.** Do not restructure a slice that reads well; fill gaps and fix errors.
- **Stay in the house format** (`docs/plans/claude-at-home-1/slice-F.md` is the model): Goal, Architecture,
  Tech Stack, Spec pointers, Global Constraints, Gates, Review Focus, Contracts, File ownership, Tasks,
  Non-goals, Risks, reviewer checklist.

## What "implementation-ready" means — the checklist

After this pass, each slice must contain all of the following. Where something is already there, leave it.

1. **File-by-file change list.** Every path created or modified, one line each saying what changes. Any file
   that another slice also touches is flagged as **shared**, with the serialisation order (who lands first)
   and what each slice adds to it.
2. **Contracts, literally.** Exact TypeScript types and function signatures, route request/response shapes,
   and SQL DDL. The migration is named (`drizzle/0NNN_<slug>.sql`) with its `_journal.json` entry shown.
   No "something like" and no pseudo-types.
3. **A step list ending in commits.** Numbered steps in order; each step ends at a commit boundary with the
   exact commit message to use. A dev agent should be able to work top to bottom and commit after every
   green test.
4. **Tests as files.** Test file paths, and for each one the behaviour it covers and the assertion that
   proves it. Include the trap cases named in the parent spec and this slice: ids after reload, stale-patch
   refusal, ownership, incognito, the sandbox bridge boundary, pointer capture on the canvas, lazy-load
   chunk sizes.
5. **i18n with real strings.** Every new key with its **English and Hungarian** value, not just the key
   name. Hungarian reads naturally; it is not a word-for-word translation.
6. **UI states.** Empty, loading, error, and long-content, at 1440 px and 390 px: which component,
   which tokens, and what the user sees. Include focus and keyboard order.
7. **Failure modes.** What happens when the model returns malformed output, the network drops mid-edit, the
   artifact is deleted while open, or the user has no permission. For each: the user-visible message
   (EN + HU) and the server's status/error code.
8. **Limits and configuration.** Every cap, timeout and admin-configurable value, with where it is read
   (`env.ts` → `config-store.ts`) and its default. Anything hard-coded instead must say why.
9. **Prototype pointers.** For each hard part, the reference file and function in the throwaway prototype
   branch, so the implementer reads working code rather than inventing an approach.
10. **A reviewer checklist.** The exact commands to run and what "pass" looks like for this slice, including
    the gate numbers (`npm run check`, `npm test`, `npm run build`, biome, fallow, `check:migrations`).

## Report back

Say, in ~250 words: what you filled, what you corrected, anything in the parent spec or `decisions.md` you
believe is now wrong (with evidence), any cross-slice conflict you found, and the questions that still need
the owner rather than an implementer — as questions with a recommendation each.
