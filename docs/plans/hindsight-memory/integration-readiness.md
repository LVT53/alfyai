# Memory release integration

Local integration began from the 19 November 2026 source freeze. The dependency session reported completion at 02:17 GMT. Both the release and dependency merges are in the local candidate. The old app cannot safely serve accounts while inactive native banks are populated. [Predeployment privacy evidence](predeployment-migration-readiness.md)

## Integration results

- The frozen Memory implementation is `1725a2da8a`. The separate release and dependency merge commits are `a74b6f4fe` and `62dc2d3b9`. Both verified tips are ancestors of the candidate. The parked Playwright branch is outside that ancestry.
- The migration journal retains all 148 released records and their SQL files. Memory's unchanged SQL now uses 0135 and 0136 at indices 148 and 149. Read Aloud keeps ADR 0070 and Memory uses ADR 0071.
- The composer preserves Send with Enter, including IME, touch and command-tray coverage, alongside durable `/remember` acknowledgement. The Profile and Guide retain Pictures and videos, Send with Enter and voice settings. The inline Memory editor and Remove confirmation use the scrolling Knowledge page, with a short-screen browser regression for both actions.
- The merged lock installed on Node 22.23.4 with `npm ci --prefer-offline --no-audit --no-fund`. Its SHA-256 is `d74c2220a208a58a49329bae38b9aadf098ddee63bb712ca3544cdf44aeb6068`. Playwright 1.59.1 resolved the installed Chromium revision 1217.
- The merged candidate passed 880 tests across 19 focused suites. A separate synthetic rehearsal ran `db:prepare` twice on a database stamped at the released tip and once on an empty database. The upgraded database retained Do Not Remember, reset generation, Memory/Pictures/Send preferences and a Hungarian Read Aloud voice. Both databases passed journal hash, index, integrity and foreign-key checks. There were zero native Memory accounts in either fixture.
- Framework references checked during the merge were the official Svelte 5 `$props` and `$derived` pages, Drizzle indexes and constraints, and Vitest's `vi` API.
- The private recovery snapshot contains the binary patch, frozen path manifests, original untracked evidence and outside-candidate hashes. Of the 21 untracked Read Aloud files that blocked the release merge, 19 matched the released bytes. The release now supplies all 21 tracked paths. The original versions of `docs/superpowers/plans/2026-11-16-read-aloud-1-speech-service.md` and `docs/superpowers/specs/2026-11-16-read-aloud-design.md` differ and are preserved at the same relative paths under `upstream-untracked-overlap/` in the private recovery snapshot.
- Independent review found that a changed Memory permission could leave the native ranking query dispatching after an asynchronous capability check. It also found that a repair hold could suppress recall from another healthy bank. Seven focused regressions reproduced those failures. Commit `3af13b999` applies the live permission fence synchronously at private dispatch, rechecks it at final admission, and excludes held banks while retaining authorized results from other banks. The nearby run passed 187 tests in 14 files and the independent review closed both findings.
- The final history-consent review closed equal-second admission, atomic Decline and preservation through Off → prepare. The repairs are in `a530fefd9` and passed eight targeted regressions and 281 focused tests. [History-consent evidence](history-consent-follow-up.md)
- The opt-in app → native → publication → recall smoke passed at the final product SHA `a530fefd9` using fresh synthetic data and the integrated lock. The first attempt exposed an upstream bridge outage and kept late native rows out of app recall. The same test passed after local bridge recovery. [Isolated final smoke](native-acceptance/integrated-smoke/README.md)
- The credential-pattern scan classified the lone unredacted PostgreSQL password as a literal in the archived synthetic launcher and used at one loopback fixture endpoint. The literal was absent from the checkout's runtime configuration files. The other loopback credentials were already redacted. The bearer and defense tokens were synthetic probes. These checks preserved evidence bytes and historical checksums.

## Recorded integration procedure

| Ref | Observed tip | Role |
| --- | --- | --- |
| `h3-deploy` | `e60bb0c11` | Base of the shared checkout's dirty Memory changes |
| `origin/main` and `origin/dev` | `0ecf205f3` | Latest observed release. It descends from the Memory base by 375 commits and includes Send with Enter. |
| Local `main` | `dea9d0e08` | Two commits behind the observed release |
| `claude/musing-kepler-83f297` | `b729c68e1` | Four dependency commits based on `dea9d0e08` |

The dependency handoff reports `finished: true` with each of the four approved commits passing its release gate. Its final Playwright 1.59.1 rerun reports 28,356 Vitest and 1,721 Playwright passes. The observed branch resolves to `b729c68e152dd1e26420ac4590e1383ed6210959`. Recheck this ref at freeze and verify that all four approved commits (`29ed544d1`, `fab25cd80`, `f446646da`, `b729c68e1`) are in the final ancestry. The parked Playwright 1.65 commit `01f31b632` is outside the dependency tip ancestry. [Dependency session status](</Users/lvt53/Library/Application Support/Claude/side-session-notes/local_00717275-5e9a-4d47-9a05-e89dd0771988/npm-update-session-status.json>)

1. Verify the index is clear and no other process is editing the checkout. Record the full commit IDs, status and the frozen per-owner paths. Reuse this checkout. Keep a private temporary recovery snapshot with a binary tracked diff and copies of the owned untracked files, preserving file modes and hashing the copies. Save separate originals if evidence needs redaction. Use a mode-0700 temporary directory with the full branch IDs, a binary Git patch, an untracked-file archive and SHA-256 manifests. Run `git diff --binary --full-index HEAD` for the tracked snapshot and copy untracked files from the reviewed NUL manifests, including the quarantined scratch files in the backup. Record unrelated path identities for before-and-after comparison. Local database and scratch data stay in place.
2. Create `codex/hindsight-memory-replacement` from the existing base carrying the frozen work. Stage by reviewed exact path manifest. Commit the cohesive reviewed application, its tests and the ADR references, then the design and reproducible research evidence. Audit the index against the manifest before each commit. Check the staged tracked diff for whitespace errors and ensure no outside-candidate or scratch path is staged. The two commits form a recovery point.
3. Merge the verified release tip first. A temporary three-way text merge at the observed tips found conflicts in `drizzle/meta/_journal.json`, `src/lib/server/db/schema.ts`, `MessageInput.test.ts`, `KnowsYouDrawing.svelte`, `KnowledgeMemoryView.svelte` and its test, and `SettingsProfileTab.svelte`. Review the automatic merges at shared boundaries as well.
4. Merge the verified dependency tip separately. At the observed tips, the dependency branch and the two release-only commits overlapped on five files and merged cleanly in isolation. The dependency diff overlaps 13 current Memory edits, including composer, chat runtime and Knowledge. Keep comparable Biome test-double fixes and verify refactors preserve behavior. Verify both recorded tips are ancestors of the integration commit.
5. Compare the remaining untracked paths with the recovery inventory. If an untracked file obstructs a new upstream file, preserve both versions before making the path available to Git.

## Inventory and evidence

The in-progress manifests are in `/tmp/alfyai-memory-integration/` in plain text and NUL-delimited form. The initial inventory found 135 modified or deleted application files, 85 untracked implementation files, and 579 untracked documentation and evidence files before this checklist. Two scratch provenance tests awaited their owner's disposition. Refresh the inventory after freeze. The `outside-candidate` list includes unrelated media, imported agent memories, scratch work and other features.

Preserve the historical source tarball and its checksums, runnable acceptance sources and dependencies, synthetic evidence, approved design and contract, and independent review records. The initial credential-pattern scan inspected unpacked and compressed content, including tar members. It recorded 19 matching paths without values. Seventeen contain PostgreSQL URLs in loopback logs, one contains a synthetic bearer probe, and one has a token-shaped defense result. Confirm those matches against fixtures before staging. Use reproducible sanitized copies and update affected checksums if redaction changes bytes. The scan does not establish screenshot contents, provenance or the absence of other secret formats. [Research archive and restore instructions](research-source/README.md)

Keep the narrow Fallow entries for the Memory CLI and shipped standalone acceptance and review sources. Confirm archived source and remaining runnable dependencies such as `alfyai-baseline/answer.cjs` are available. Run pinned Fallow against the integrated release baseline. Compare any findings for unrelated untracked sources against the original inventory.

## Reconcile the shared boundaries

- **Migrations and schema.** Keep released SQL files and the released journal prefix byte-for-byte. At the observed tip, the journal ends at index 147 with `1777140000134_users_send_with_enter`. Append `1777140000135_hindsight_memory.sql` and `1777140000136_memory_source_acceptance.sql` at indices 148 and 149 if that tip still holds. Keep Memory DDL order, version and breakpoint flags. Check unique timestamps and tags, file/journal agreement and increasing indices and timestamps. Fix direct source links and preserve historical evidence hashes as historical. Recreate synthetic databases that previously applied the colliding numbers. Keep the release's read-aloud voices, preferences, take ETA and analytics uniqueness. Preserve release additions in the preparation script, account export and owned-table registry.
- **ADR.** The release already uses ADR 0070 for Read Aloud. Allocate the next ADR to Memory, 0071 at the observed tip. Update the heading, filename, index, direct links and Memory references in root and service `AGENTS.md` and implementation notes. Record the profile-memory supersession in ADR 0045.
- **Settings and composer.** Combine Memory's private consent and cleanup handling with release Send with Enter, Pictures and videos and voice preferences. Preserve the app-shell store and composer key helper behavior for IME, touch keyboards and the command tray. Keep the pictures and videos permission in the tools and both English-only turn guidance branches. Keep Memory source fences and fail-closed recall and Incognito checks. The release's `server/utils/request-abort-signal.ts` and Memory's outbound prompt leaf each serve existing callers.
- **Knowledge and Guide.** Preserve the release behavior that keeps tall Remove and Edit controls reachable on short screens. Carry the regression to the surviving interactions. Keep Memory source navigation, Documents behavior, the Guide drawings and the release's Pictures and videos and Send with Enter spotlights.
- **Dependency resolution.** The observed branch upgrades Biome 2.4.12 to 2.6.8, Vite 8.1.3 to 8.3.8, Vitest 4.1.11 to 4.1.12, SvelteKit 2.70.3 to 2.70.4, Tailwind 4.2.1 to 4.3.5, Drizzle ORM 0.45.2 to 0.45.4 and better-sqlite3 12.8.0 to 12.11.1. It retains Playwright and playwright-core 1.59.1, Svelte 5.56.10, svelte-check 4.4.6, adapter-node 5.5.4 and Fallow 3.33.1. Preserve release direct `entities` 6.0.1 and `tinyld` 1.3.4, the typecheck heap adjustment and `tinyld` chunk guard, and the dependency branch's canvas budget and Biome settings. Verify the manifest and lock agree. Install via `npm ci` on Node 22 and verify the existing Chromium revision 1217.

## Check the integrated candidate

- Run `npm run check:migrations`, `scripts/prepare-db.test.ts` and the Memory migration, publication and CLI suites. Run `db:prepare` twice against a disposable synthetic database stamped from the released journal with representative users, legacy exclusions and preferences, and once against an empty disposable database. Use an explicit temporary `DATABASE_PATH`. Compare released journal hashes, retained settings and authority, required indexes, integrity and foreign-key checks. Confirm the start command, deployment preparation and health route use the reconciled schema.
- Exercise settings/preferences, account export and erasure, chat parsing and finalization, prompt-language purity, context-budget, composer and turn-runtime tests. Verify Memory evidence admission beside latest-main picture and video consent and Send with Enter. Check both locales, Guide drawings and spotlight targets.
- Re-run synthetic native acceptance with the integrated source and dependency lock. Cover comparative EN/HU lifecycle, edit/resend, source deletion, project move, curation and dependency repair, failure and restore, capacity and cleanup. Record the exact integrated SHA and lock hash.

Run the repository agent gate once after focused checks and reviewed fixes. Use an unused port base and a dedicated log directory.

```sh
scripts/gates.sh agent "$TMPDIR/alfyai-memory-integrated-gates" --port 4610 \
  tests/e2e/memory-replacement.spec.ts \
  tests/e2e/knowledge.spec.ts tests/e2e/home-memory-review-notice.spec.ts \
  tests/e2e/everyday-redesign-screens.spec.ts \
  tests/e2e/zz-knowledge-polish-capture.spec.ts \
  tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/composer-command-v1.spec.ts tests/e2e/composer-chips.spec.ts \
  tests/e2e/send-with-enter.spec.ts tests/e2e/feature-guide.spec.ts \
  tests/e2e/settings-admin.spec.ts tests/e2e/settings-admin-system.spec.ts \
  tests/e2e/settings-profile-redesign.spec.ts tests/e2e/login.test.ts \
  tests/e2e/project-page.spec.ts tests/e2e/ask-me-first.spec.ts \
  tests/e2e/read-aloud-voices.spec.ts tests/e2e/images-video.spec.ts
```

The Knowledge polish capture spec requires `KNOWLEDGE_CAPTURE=1` to produce images. Check the agent-gate outputs for typecheck, Biome, migrations, Vitest, warning-free build, artifact chunks, pinned Fallow and Playwright. Full release-gate coverage of the integrated dependency update is required before declaring the combined release ready. The dependency session's result covers its own tip. The predeployment privacy blocker still controls real enrollment. [Migration runbook](migration-runbook.md)
