Continue the Normal Chat completion work on branch `fix/turn-completion` (worktree `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`, validated commit `29e51551f`, deployed to staging only; production stays `40f2d74fc`).

An independent review on 2026-11-11 ruled the branch not ready for production. Read it first, in full:

`/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/docs/plans/turn-completion-review/fable-verdict-2026-11-11.md`

Its reproducers are in the `reproducers/` folder beside it. They are saved as `.txt`; a `~` in a file name stands for `/` in the path the file belongs at. Both live in the main checkout, untracked: read them there, and copy the memo into your branch if you want it tracked.

Fix these, in this order. Section numbers refer to the memo.

1. 1.1: save and serve compact output events, not one per streamed token. Add a test that bounds stored metadata against answer length.
2. 1.2: an answer that opens with a JSON code block must never be erased.
3. 2.1 (owner ruling: regression): bring live answer streaming back. The memo's "Required fix" lists what must stay true. The owner has confirmed that a remark written before a tool call is withdrawn from the answer area when the call arrives; do not ask again.
4. 2.2 (owner ruling: regression): a file job that fails after submission is a known outcome; the model sees it and continues.
5. 1.3: no generation after Stop (the capacity-backoff timer).
6. 1.4 f: restore tool-call JSON repair on the completion path.
7. 1.4 c: "answered, nothing saved" is a failure for an observing client.

Then the rest of 1.4, then 1.5 and the unprotected guards in section 6. Say plainly which of those you leave open.

Rules:

- For each fix, first run its reproducer and see it fail, then make it pass. Do not weaken an assertion. The one existing test that asserts the old file-job behavior is replaced, as the memo says.
- Amend the contract documents and ADRs that accepted the two regressions, so documents and code agree.
- Keep what the review found sound (memo section 5). No rule on a text's words, length or punctuation may decide commentary versus answer.
- Finish with the full release gate, then deploy the side branch to staging only. Never push to `dev` or `main`, never touch production.
- The closing phase has never run against a real provider (memo section 3, and section 7 item 8). Propose the two DeepSeek Flash cases to the owner and run them only after an explicit yes. No other new model runs without asking.
- Report with evidence: what changed, each reproducer before and after, the gate output, and what is still open.
