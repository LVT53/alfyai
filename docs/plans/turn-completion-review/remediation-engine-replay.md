# Engine and replay remediation evidence

## 1.4 g, h, i, j

- Original A-completion g/h/i cases extracted without changing assertions: four failures in `/tmp/turn-completion-remediation/1.4-ghi-original-red.log`, then all four pass in `1.4-ghi-green.log`.
- g retains failed partial text/reasoning in the audit but excludes it from fallback context; picture insert boundaries and eligibility remain intact.
- h removes only unmatched calls proven definitely not executed from closing context. Matched results and uncertain executions retain existing protections.
- i detects explicit DSML anywhere, without treating JSON fences or prose words as tool syntax.
- Original F-transient measurement ran first (`1.4j-original-before.log`). Exact tools-on/working-phase assertions then failed on both transports (`1.4j-invariant-red.log`). One same-provider tools-on retry is now allowed only before upstream output/tool occurrence, within the original deadline and after fallback options. Repeated failure is bounded to two requests and ends failed without closing.
- Six focused suites pass 150 tests (`1.4-ghij-focused-green.log`), including retry caps, text/reasoning output guards, uncertain tool guards, SDK image eligibility and JSON preservation. Two image eligibility tests previously expected closing after a pre-output throw; their exact phase expectations now require working retry, with the two-request bound and all pixel/outcome assertions retained.
- No model calls, build or full release gate run here. Official AI SDK tool-calling docs and Svelte/Vitest docs were checked in the preceding related slices.

## 1.4 a — server replay retention

- Original `zz-review-main-journal-overflow` measurement ran unchanged (`1.4a-original-before.log`); its original source remains beside the review memo. Added desired invariant failed on the same 3,157-token fixture (`1.4a-invariant-red.log`).
- The wire journal now combines scoped block deltas and legacy channel deltas while retaining structural order, first sequence and a strict 200,000-byte/10,000-frame bound. Partial SSE frames are assembled incrementally; unavailable prefixes never become replayable suffixes. Live emission is unchanged.
- The reviewed turn is fully replayable below 40,000 bytes and 30 retained frames. Tests cover escaped-byte bounds, independent attempt/block scope, replay idempotence, subsequent live deltas, immutable earlier snapshots and split frames.
- Actual two-invocation browser transport test consumes the first delta before disconnect, replays a compact delta with the same sequence into the new accumulator, replaces the retained message view at replay-end, and applies a duplicated later live event exactly once. Exact final text is `First second third`; reconnect carries the existing scoped stream ID. The runtime's existing atomic replacement test separately pins the callback handoff.
- Six focused suites pass 48 tests (`1.4a-focused-green.log`). The reconnect server already passes pending observation deadlines through unchanged; the paired client polling fix is owned by the other worker.
- The live per-token wire bandwidth is unchanged and remains a separate 1.5 concern. Replay compaction does not claim to solve that cost. A full release gate remains pending with the orchestrator.
