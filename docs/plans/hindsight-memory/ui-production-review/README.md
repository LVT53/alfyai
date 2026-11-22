# Memory UI production check

November 19, 2026. The production-built Knowledge UI was run in Chromium with English and Hungarian preferences at 1440px and 320px. The browser used loopback instances and fictional accounts. The review used the [agreed design](../agreed-ui-design.md) and followed the [development review](../ui-live-review/README.md).

## Real app API and native worker

| Check | Result |
| --- | --- |
| List and detail | The actual personal and project lists loaded. Authorized detail showed the original quote, its date, and the original chat link. Add, Edit, Remove, empty and off states fit at both widths. |
| Older chat source | The target was absent from the first 100 messages. Chromium fetched a further eight, scrolled to the exact source, applied the message highlight, cleared the URL parameter and recovered the Memory search on Back. This passed with ordinary and reduced motion. |
| Keyboard | Enter opened the list row. Detail, Edit and Add moved focus to their headings. Back restored query, space, and focus to the exact row. Cancel Add returned to Add. The real Remove operation returned focus to Search. Memory headings use the same keyboard focus ring as the Guide. A pointer-first click focuses the heading without a ring. Chromium can retain the ring when a click activates the row that already has keyboard focus. |
| Hover and reduced motion | Both sides of the row had 12px of padding. The row tinted on hover. Its 150ms transition and 2px chevron motion became 0.01ms and zero displacement in reduced motion. |
| Profile control | Turning Memory off in a second tab disabled Save or Remove in the open form and kept the draft. The Memory page sent zero mutation requests. Both preference writes and list reads used the real app API. Headless Chromium's focus event was dispatched when bringing the original tab forward did not immediately refresh it. |
| Add, Edit, versions and Remove | All three browser submissions reached the local native worker and applied in one attempt each. In a fresh synthetic project, Add showed “Added by you”. Edit removed “red” from a clamp's description, kept the rest, and exposed the exact accepted earlier wording in the detail API and Previous versions. Remove acknowledged exclusion, completed cleanup, and returned an empty list. |

| Language | Desktop | 320px |
| --- | --- | --- |
| English | [List](screenshots/native-en-1440-list.png) · [Detail](screenshots/native-en-1440-detail.png) | [List](screenshots/native-en-320-list.png) · [Detail](screenshots/native-en-320-detail.png) |
| Hungarian | [List](screenshots/native-hu-1440-list.png) · [Detail](screenshots/native-hu-1440-detail.png) | [List](screenshots/native-hu-320-list.png) · [Detail](screenshots/native-hu-320-detail.png) |

At 320px the native selector clips an exceptionally long project name while closed. The full option remains present in the chooser, and the control stays within the card. [Long project label](screenshots/native-hu-320-long-project.png)

[English Add](screenshots/native-en-320-add.png) · [Edit](screenshots/native-en-320-edit.png) · [Remove](screenshots/native-en-320-remove.png) · [Keyboard focus in list](screenshots/native-en-320-keyboard-focus.png) · [Keyboard focus in detail](screenshots/native-en-320-detail-keyboard.png) · [Standard hover](screenshots/native-en-1440-hover.png) · [Reduced hover](screenshots/native-hu-320-hover.png)

[Hungarian Add](screenshots/native-hu-320-add.png) · [Edit](screenshots/native-hu-320-edit.png) · [Remove](screenshots/native-hu-320-remove.png) · [Off](screenshots/native-hu-320-off.png) · [Off while editing](screenshots/native-en-off-edit.png) · [Off while confirming removal](screenshots/native-en-off-remove.png)

[Exact chat source, ordinary motion](screenshots/native-source-highlight-standard.png) · [Exact chat source, reduced motion](screenshots/native-source-highlight-reduced.png)

[Real Add](screenshots/native-mutation-added-by-you.png) · [Real Previous versions, desktop](screenshots/native-mutation-previous-versions.png) · [Real Previous versions, 320px](screenshots/native-mutation-previous-versions-320.png) · [After real Remove](screenshots/native-mutation-removed.png)

## Injected UI responses

Five production browser cases exercised specific UI contracts. At both widths and in both languages, a long two-source memory fit without horizontal overflow. Its uncertain row date was absent in the list and detail while both source dates appeared beside their quotations. Previous versions opened and closed from the keyboard. A failed first read showed one alert and one Retry. A failed Edit retained the draft through dismissal and sent the same request on Retry. A dismissed cleanup alert left the acknowledged exclusion visible and Remove disabled. A 28-row list returned to the same scroll position at 1919px and focused the same row at 320px.

[Long undated row](screenshots/contract-hu-320-long-row.png) · [Two source dates and Previous versions](screenshots/contract-hu-320-sources-and-versions.png) · [Initial read error](screenshots/contract-hu-320-initial-error.png) · [Edit error and retained draft](screenshots/contract-en-320-edit-error.png) · [Cleanup pending](screenshots/contract-en-320-cleanup-pending.png) · [Restored list scroll](screenshots/contract-en-320-restored-scroll.png)

## Reproduction

The isolated build uses Node 22.23.4 and the repository's Playwright setup with pinned Chromium 147.0.7727.15 (Playwright Chromium revision 1217). The fixture is a SQLite backup of the synthetic development review database. The production runtime starts from the Node adapter output. Its Memory worker connects to the isolated loopback Hindsight service. The independent repository browser spec starts its own app and freshly seeded database.

Run the commands from the isolated application directory. Set `PLAYWRIGHT_BROWSERS_PATH` to the review directory's `browsers` cache.

```sh
npm run build
npm test -- KnowledgeMemoryView.test.ts src/lib/client/api/memory.test.ts
E2E_SERVER=build E2E_PORT=18949 E2E_WORKERS=1 npm run test:e2e -- tests/e2e/memory-replacement.spec.ts
npm exec playwright -- test -c review.config.mts --reporter=list
npm exec playwright -- test -c faults.config.mts --reporter=list
npm exec playwright -- test -c mutations.config.mts --reporter=list
```

The first repository browser run showed the older-message case could never request an older window with only 85 later messages. The fixture now adds 101 and first checks the initial response has older messages and excludes the source. The browser assertions require the earlier fetch, exact highlight, and restored search. All eight repository browser cases passed with the corrected fixture and final keyboard focus styling. The date regression suite passed 43/43 after reproducing the old transport rejection and incorrect January 1970 display. The final build completed, and its typecheck reported zero errors and warnings.

Context7 and the Svelte MCP docs were unavailable. Checked the official Svelte conditional markup guide, Vitest guide, and Playwright test and API request references. [Svelte conditional markup](https://svelte.dev/docs/svelte/if) · [Vitest guide](https://vitest.dev/guide/) · [Playwright assertions](https://playwright.dev/docs/test-assertions) · [Playwright request API](https://playwright.dev/docs/api/class-apirequestcontext#api-request-context-get)

Build source base `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`. The date-aware snapshot's SHA-256 manifest is `7279d0e0c63df1d58abc27f62ee5c3ad8a5d1f8a45dbd5e63b55f8796012c4f5`. The subsequent snapshot with the Guide's focus treatment is `167e54667aff43d96c74853a4d4f47e50394090d3e589f0edb757ca74a5dcd5e`. Logs, the complete manifests, extra captures and the browser review scripts are under `/tmp/alfyai-memory-production-review.pmfHfI/dated` and `/tmp/alfyai-memory-production-review.pmfHfI/focus`. The separate release integration and gates use the shared checkout.
