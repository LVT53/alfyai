# Memory UI live-review fixes

The five findings from the development review have UI changes in the Knowledge Memory components and regression coverage in the component tests or the production Playwright spec. [Development review](ui-live-review/README.md)

| Finding | Change | Regression |
| --- | --- | --- |
| Source attribution | Explicit manual origin shows “Added by you” in English and Hungarian. Unknown origin with an empty source list omits the card. Unavailable evidence describes the source. Verified chat evidence keeps its title, original quote and deep link. | The rendered component checks both locales, unknown origin, withheld text and the existing verified quote. |
| Initial read failure | The shared error alert owns Retry. The list shows empty copy only after an accepted response. | The first read fails, exposes one alert and one Retry, then recovers into an accepted empty list. Dismissal also leaves the absent page distinct from empty. |
| Return focus | Cancel Add returns to Add. Back restores the exact row and scroll when the row still exists. Search receives focus after removal or when the row or Add is unavailable. | Component cases cover fresh and previously opened lists, a removed row still cached during refresh and a missing row. The browser case exercises Enter and Cancel at 320px. |
| Memory off | An authoritative off flag disables Save and Remove and withdraws mutation Retry. Status lookup can still read an outstanding operation. The existing off notice gives the reason and points to Profile. | Focus refresh tests cover open Edit and Remove with zero mutation submissions after the off response. A failed edit loses its Retry control when the off response arrives. |
| Reduced motion | Hover tint applies in both motion modes. The 2px chevron movement applies only with ordinary motion. | The browser spec reads the computed hover color and actual chevron position in both modes. |

## Changed files

- Knowledge Memory coordinator, list, detail, editor and stylesheet. [Coordinator](<../../../src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte>) · [List](<../../../src/routes/(app)/knowledge/_components/MemoryList.svelte>) · [Detail](<../../../src/routes/(app)/knowledge/_components/MemoryDetail.svelte>) · [Editor](<../../../src/routes/(app)/knowledge/_components/MemoryEditor.svelte>) · [Styles](<../../../src/routes/(app)/knowledge/_components/memory-replacement.css>)
- English and Hungarian evidence labels and more precise copy for a missing memory. [Knowledge translations](../../../src/lib/i18n/knowledge.ts)
- Component and production browser regressions. [Component tests](<../../../src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts>) · [Playwright spec](../../../tests/e2e/memory-replacement.spec.ts)

## Verification

The component red run reproduced the provenance, duplicate Retry, off control and focus failures. After isolating one-shot list mocks between tests, the confirmation run reproduced fresh Add focus loss and duplicate Retry independently. The original post-dismissal empty-state check passed in that run. Logs are in `/tmp/alfyai-memory-ui-review-red.log` and `/tmp/alfyai-memory-ui-review-red-isolated.log`.

The final Node 22 run passed 109 tests across the coordinator and existing hover and reduced-motion suites. `npm run check` reported 0 errors and 0 warnings. Biome passed on the four touched TypeScript and CSS files it checks. Logs are in `/tmp/alfyai-memory-ui-review-green-final.log`, `/tmp/alfyai-memory-ui-review-check.log` and `/tmp/alfyai-memory-ui-review-biome.log`.

Context7 and the Svelte MCP docs were unavailable. Checked the official Svelte docs for `tick`, DOM refs and conditional markup, the Vitest guide, Playwright media emulation and MDN reduced-motion media queries. [Svelte tick](https://svelte.dev/docs/svelte/svelte#tick) · [Svelte bind:this](https://svelte.dev/docs/svelte/bind#bind-this) · [Svelte conditionals](https://svelte.dev/docs/svelte/if) · [Vitest](https://vitest.dev/guide/) · [Playwright media emulation](https://playwright.dev/docs/api/class-page#page-emulate-media) · [MDN reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)

## Browser verification still open

The production Playwright gate and the desktop and 320px walkthrough remain open. The walkthrough should cover actual keyboard navigation, focus visibility, both motion settings, the two-tab Profile toggle, verified prior wording, and the earlier-message quote scroll and highlight. The provenance worker owns the server classification that distinguishes a verified manual Add from a conversation-derived Edit with unavailable evidence.
