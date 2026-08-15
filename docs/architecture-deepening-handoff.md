# Handoff prompt — architecture deepening orchestrator

Paste everything below the line into a fresh session.

---

You are the orchestrator for the AlfyAI architecture deepening programme.

**Your backlog is `docs/architecture-deepening-slices.md`. Read it in full before doing anything
else.** It is the single source of truth for scope, ordering, real file surfaces, ADR
constraints, and gates. It also contains a verification ledger recording which claims were
confirmed by hand and which were not — treat the unverified ones as hypotheses to prove, not
facts to act on.

## How to work

- **Sequential waves.** Wave 0 → 1 → 2 → 3, with **Wave S** starting after Wave 1 and running
  alongside Wave 2. Wave exits are autonomous on a green gate except the two scheduled stops
  below. Within a wave, run slices in parallel **only** where the slice explicitly says it is
  parallel-safe.
- **Spawn implementation subagents as Sonnet 5** (`model: "sonnet"`). Reserve your own
  higher-cost reasoning for orchestration: slice review, gate verification, ADR-conflict
  judgement, and the stop-and-ask decisions. Implementation, test-writing, and mechanical
  refactors go to Sonnet 5 subagents.
- **SDD.** Every slice produces its spec artifact (ADR and/or `CONTEXT.md` term) *before* the
  implementation commit, not after. If a slice names a new concept, it goes in `CONTEXT.md`.
  **§1 of the backlog contains an ADR deliverables ledger — every ADR listed there is part of
  its slice, not follow-up work. A slice is not done until its ADR is committed.** ADR-0056,
  ADR-0059 and ADR-0060 are already written and accepted; **0054 and 0055 are yours to write**.
  Next free number is **0061** — the 0050/0051 collisions were resolved on 2026-08-15 (the
  duplicates became 0057 and 0058). This is how we avoid regressing decisions we just made.
- **TDD, genuinely red first.** Each slice lists the failing tests to write. Write them, watch
  them fail, and paste the failure output into your progress note before writing implementation.
  A test that passes on first run is a bug in the test — investigate rather than proceed.
- **One commit per slice.** Commit messages explain *why*. Follow `AGENTS.md` § Commit and Push
  Discipline.
- **Update the backlog as you go.** Flip ⬜ → 🟨 → ✅, fill in the Wave baselines table, and
  record the before/after numbers each slice asks for.

## Before touching code

`AGENTS.md` § Mandatory Docs Check requires you to confirm current APIs through Context7 / the
Svelte MCP docs tools for any framework surface you touch — Svelte, SvelteKit, Vitest,
Playwright, Drizzle, Tailwind. Do not write framework code from memory. If those tools are
unavailable, say so explicitly and use official docs.

## Gate for every slice

```bash
npm run check    # 0 errors, 0 warnings
npm run lint
npm test         # no regression from the wave baseline
npm run build    # 0 warnings
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Plus the targeted Playwright suites named in the slice. A slice is not done until the gate is
green and you have shown the output.

## Hard constraints — these are the ones that cause a mess

1. **R1 follows ADR-0060** (accepted; supersedes ADR-0019 on ownership only). The runtime may
   own turn state. **Ship the two defect fixes first** — they are the user-visible win and are
   independently deployable — then move ownership one concern at a time. No slice may leave two
   owners for the same field. Record the adapter member count; it starts at 82.
2. **E1/E2 are constrained by ADR-0025.** Reuse the existing `data-stream-error` framing. Do not
   invent stream part names.
3. **O1 is constrained by ADR-0022.** The read model keeps payload assembly. A bounded range is a
   parameter, not a relocation.
4. **X1 follows ADR-0059** (accepted; both conventions already amended). Strangler only, ordered
   last, second in-memory adapter ships with the seam, and the halfway-point check halts it
   automatically if it is not earning its keep. Per-table repository wrappers remain forbidden —
   the exception is one *execution* seam, nothing wider.
5. **G1 must not begin until G0's eval baseline exists.** We have proven the prompt varies; we
   have not proven the variation degrades answers. Without the baseline the change is
   unfalsifiable.
6. **G1 must not reopen ADR-0046.** The fix removes the classification problem; it does not
   replace the regex with a model call.
7. **Wave S must not start before M1 has collected real traffic.** A user complained about
   speed and we currently cannot tell how much of the wait is our own server-side work versus
   the model's reasoning. Building perception fixes for removable latency is the wrong repair.
   Fill the latency baseline table in §6 first, then decide.
8. **P3 (the step classifier) must not be enabled in production before the honesty audit
   passes** — >95% truthful, zero fabricated action claims. A rail that lies is worse than the
   stopwatch it replaces.
9. **No English-regex gating of user-facing content, anywhere, ever again.** G1 exists to
   delete that pattern; do not reintroduce it in Wave S. Discourse-marker matching may decide
   *when* to sample the reasoning stream, never *what the user reads*.

## Autonomy

**This programme runs unattended.** The repository owner has granted standing authorization to
push and deploy the slices in this backlog, scoped to this backlog only — that is the explicit
request `AGENTS.md` § Commit and Push Discipline requires. Nothing here authorizes autonomous
push or deploy for anything else.

There are exactly **two scheduled stops**:

1. **After M1** — post the §6 latency table and wait. It decides whether the speed complaint is
   server-side or model reasoning, which changes what Wave S is for.
2. **After G0/G1** — post the eval before/after and the prompt-cache delta, and wait.

Everything else proceeds on a green gate: commit, push, **deploy to staging, verify, soak**,
then production.

**Staging is the safety net that makes this autonomy reasonable.** A live staging environment
exists at `~/apps/langflow-chat-dev` (branch `dev`, port 3002, `ai.dev.alfydesign.com`, its own
disposable database). Slice **D0** brings it current — it is 915 commits behind, though with
zero unique commits, so the catch-up is a fast-forward.

Every deploy lands on staging first, soaks, and only then reaches the 6 real users. A failure on
staging is staging working correctly — fix and redeploy there, do not halt. A failure on
production is always a halt, after rolling back.

## Automatic halt conditions

Stop and report. **Do not work around any of these** — working around them is the failure mode
this programme exists to avoid.

- A gate red that cannot be fixed inside the slice that caused it
- Test count regression against the wave baseline
- New Fallow findings, or any temptation to add an ignore, suppression, or `svelte-check` exception
- **Production** post-deploy health check failure — roll the symlink back first, then stop.
  (A *staging* failure is not a halt.)
- Any migration that would drop or rename a column
- Any write to the production database beyond `db:prepare` migrations
  (staging's database is disposable — recreating it needs no approval)
- An ADR conflict not already resolved in §1 of the backlog
- G0/G1 eval regression on any scored dimension
- Honesty audit below 95% truthful, or any fabricated action claim
- X1's halfway-point check failing
- Anything requiring a secret, credential, or payment
- Two consecutive slices failing for the same underlying reason
- The code contradicting the backlog in a way that changes a slice's shape

A halt is not a failure. Reporting one early is the cheapest outcome available.

## If a claim in the backlog turns out to be wrong

Several numbers in the review were corrected during verification; more may be wrong. If the code
does not match the backlog, **stop and report the discrepancy** rather than adapting the plan
silently. Update the verification ledger with what you found.

## Server access

You have SSH to the production box. Granted by the human on 2026-08-15:

| Account | Use for |
|---|---|
| `alfyws` | general inspection, GPU/vLLM state, process and port checks |
| `alfydesign` | the app itself — code at `/home/alfydesign/apps/langflow-chat`, and the prod DB |
| `alfyroot` | only when the above genuinely cannot do it |

**Rules for using it:**

- **Read-only for inspection.** Deploys are authorized; ad-hoc production state changes are not.
- **Never print secrets.** The `providers` table holds `api_key_encrypted`; `.env` holds keys.
  Select named non-secret columns; never `select *` from `providers`, never dump `.env`.
- **Before any write to the prod DB, take a backup and say so.** There is precedent in
  `data/chat.db.backup-*`. Migrations go through `npm run db:prepare` only — **never
  `db:push`** against production.
- Deploys and service restarts remain stop-and-ask regardless of access.
- Prefer `sqlite3 -readonly` for every inspection query.

## Production environment

§0 of the backlog contains **verified** production facts gathered over SSH on 2026-08-15. They
override the repo's `deploy/*` templates, which are wrong about the install path and service
user. Read that table before D1. In particular: the app lives at
`/home/alfydesign/apps/langflow-chat` as `alfydesign`, `SHUTDOWN_TIMEOUT` is unset, and the
Apache vhost is Virtualmin-managed.

The same section records the deployment's real scale — 6 users, 2 196 messages, largest
conversation 89 messages. **This downgrades the claimed impact of S1, O1 and X1.** They remain
correct changes; they are not latency fixes at this scale. Do not oversell them in commit
messages, and do not let them displace Wave S, which is where the actual speed complaint lives.

## Start here

1. Read `docs/architecture-deepening-slices.md` (§0 first), `AGENTS.md`, and `CONTEXT.md`.
2. Read `docs/adr/0056-interim-thought-steps-are-durable-turn-state.md` — already written,
   status Proposed. It is the contract Wave S implements.
3. Record the Wave 0 baseline (test pass/fail, `npm run check` count, Fallow findings).
4. Begin slice **D0** — restore staging. It is the first slice and everything else deploys through it.
