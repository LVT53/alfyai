# Native /remember origin and Incognito race fixes

Both findings in review-ui-rereview2.md are fixed in the existing composer/host boundary.

1. HomeSurface now provides a dedicated memory-command preparation callback. It captures the original project and preparation epoch before waiting. Unlike ordinary draft preparation, it refuses a replacement conversation when the scope changed. MessageInput also refuses completion after unmount or a bound conversation change. Deferred regression starts the command in project A, holds creation, rerenders the same HomeSurface in project B, releases A, allows the existing preparer to resolve B, and verifies **zero memory-note submissions**.
2. MessageInput refuses `/remember` when its Incognito prop or local Incognito state is on, before and after asynchronous preparation. Home's callback additionally waits for the exact existing incognitoArmReconciliation promise used by normal send, then rechecks scope and privacy. Deferred regression creates a normal prepared chat, arms Incognito, holds its PATCH, submits `/remember`, and verifies **zero memory-note submissions while the PATCH is pending**. The server remains responsible for its final authenticated eligibility check.

No new general UI, storage protocol or backend assumption was introduced.

## Evidence

- Red: `/tmp/memory-command-races-red2.txt` — both actual HomeSurface/MessageInput deferred-promise regressions failed before the fix (2 failed, 26 unrelated tests skipped).
- Green: `/tmp/memory-command-races-green.txt` — **305 tests passed in 2 complete suites**, HomeSurface.test.ts and MessageInput.test.ts, using Node22.
- Scoped Biome: `/tmp/memory-command-races-biome.txt` — clean after formatting the three modified files.
- Existing jsdom pseudo-element diagnostic appeared in the component run; zero test failures. No build, full gate, browser execution, deployment or real-user migration was performed. Coordinated typecheck and browser acceptance remain owned by the orchestrator.

Changed source: src/lib/components/home/HomeSurface.svelte and src/lib/components/chat/MessageInput.svelte. Regression source: src/lib/components/home/HomeSurface.test.ts.
