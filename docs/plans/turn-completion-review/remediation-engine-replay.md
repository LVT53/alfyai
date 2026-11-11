# Engine and replay remediation evidence

## 1.4 g, h, i, j

- Original A-completion g/h/i cases extracted without changing assertions: four failures in `/tmp/turn-completion-remediation/1.4-ghi-original-red.log`, then all four pass in `1.4-ghi-green.log`.
- g retains failed partial text/reasoning in the audit but excludes it from fallback context; picture insert boundaries and eligibility remain intact.
- h removes only unmatched calls proven definitely not executed from closing context. Matched results and uncertain executions retain existing protections.
- i detects explicit DSML anywhere, without treating JSON fences or prose words as tool syntax.
- Original F-transient measurement ran first (`1.4j-original-before.log`). Exact tools-on/working-phase assertions then failed on both transports (`1.4j-invariant-red.log`). One same-provider tools-on retry is now allowed only before upstream output/tool occurrence, within the original deadline and after fallback options. Repeated failure is bounded to two requests and ends failed without closing.
- Six focused suites pass 150 tests (`1.4-ghij-focused-green.log`), including retry caps, text/reasoning output guards, uncertain tool guards, SDK image eligibility and JSON preservation. Two image eligibility tests previously expected closing after a pre-output throw; their exact phase expectations now require working retry, with the two-request bound and all pixel/outcome assertions retained.
- No model calls, build or full release gate run here. Official AI SDK tool-calling docs and Svelte/Vitest docs were checked in the preceding related slices.
