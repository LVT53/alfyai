import { describe, expect, it } from "vitest";
import {
	derivePersonaFactsBudget,
	PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET,
	PERSONA_FACTS_MIN_TOKEN_BUDGET,
} from "./persona";

describe("derivePersonaFactsBudget", () => {
	it("returns the base budget when there is no summary to reserve for", () => {
		expect(
			derivePersonaFactsBudget({ baseBudget: 4_000, summaryTokens: 0 }),
		).toBe(4_000);
	});

	it("reserves summary tokens out of the base budget", () => {
		expect(
			derivePersonaFactsBudget({
				baseBudget: PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET,
				summaryTokens: 2_000,
			}),
		).toBe(PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET - 2_000);
	});

	it("never drops below the minimum facts budget", () => {
		expect(
			derivePersonaFactsBudget({
				baseBudget: PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET,
				summaryTokens: 100_000,
			}),
		).toBe(PERSONA_FACTS_MIN_TOKEN_BUDGET);
	});
});
