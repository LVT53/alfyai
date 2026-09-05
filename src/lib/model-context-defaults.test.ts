import { describe, expect, it } from "vitest";
import {
	deriveDefaultCompactionUiThreshold,
	deriveDefaultTargetConstructedContext,
	deriveModelContextLimits,
	normalizeModelContextTokens,
} from "./model-context-defaults";

describe("model context defaults", () => {
	it("derives target and compaction defaults from max context", () => {
		expect(deriveDefaultTargetConstructedContext(1_000_000)).toBe(900_000);
		expect(deriveDefaultCompactionUiThreshold(1_000_000)).toBe(800_000);
	});

	it("matches the conversation_context_status column defaults for the default window", () => {
		// schema.ts: max_context_tokens 262144, threshold_tokens 209715,
		// target_tokens 235929 (fixed by 1777140000086_context_status_prompt_usage).
		expect(deriveDefaultTargetConstructedContext(262_144)).toBe(235_929);
		expect(deriveDefaultCompactionUiThreshold(262_144)).toBe(209_715);
	});

	it("normalizes missing context windows to the shared default", () => {
		expect(normalizeModelContextTokens(null)).toBe(262_144);
		expect(normalizeModelContextTokens(32_000)).toBe(32_000);
	});

	it("keeps explicit limits while deriving missing ones", () => {
		expect(
			deriveModelContextLimits({
				maxModelContext: 250_000,
				targetConstructedContext: 180_000,
			}),
		).toEqual({
			maxModelContext: 250_000,
			targetConstructedContext: 180_000,
			compactionUiThreshold: 200_000,
		});
	});
});
