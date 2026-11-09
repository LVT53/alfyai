/**
 * The tier table of the spec (S4), row by row, against the server shapes MinerU
 * 4.1 can have: its ceiling is the tier it was started with, and `/v1/tiers`
 * lists everything up to it.
 */

import { describe, expect, it } from "vitest";
import type { MineruTierId } from "./config";
import { mapMineruError } from "./errors";
import { mineruTierListSchema } from "./schemas";
import { readMineruProtocolFixture } from "./testing/fake-server";
import { decideOcrMode, decideTier, isMineruTierId } from "./tier-policy";

function tiersFrom(file: string): MineruTierId[] {
	const capture = readMineruProtocolFixture<{ response: { json: unknown } }>(
		file,
	);
	return mineruTierListSchema
		.parse(capture.response.json)
		.data.map((tier) => tier.id);
}

// What the 4.1.7 box answered with `--tier standard`, and the two lower ceilings.
const STANDARD_SERVER = tiersFrom("server/tiers.json");
const BASIC_SERVER: MineruTierId[] = ["flash", "basic"];
const FLASH_SERVER: MineruTierId[] = ["flash"];

describe("decideTier: the server shapes", () => {
	it("reads the 4.1 capture as the production ceiling", () => {
		expect(STANDARD_SERVER).toEqual(["flash", "basic", "standard"]);
	});

	describe("a native document (Office, HTML, CSV, EPUB, ...) never names a tier", () => {
		// `.docx` + `tier: standard` ran as flash, and `.docx` + `tier: advanced` was
		// accepted at create and never ran (spike D14): there is nothing to gain from
		// asking and a stuck task to lose.
		it("omits the key whatever the server, the setting or the hint says", () => {
			const inputs = [
				{ configuredTier: "auto" as const, availableTiers: STANDARD_SERVER },
				{ configuredTier: "auto" as const, availableTiers: FLASH_SERVER },
				{ configuredTier: "auto" as const, availableTiers: [] },
				{
					configuredTier: "standard" as const,
					availableTiers: STANDARD_SERVER,
				},
				{
					configuredTier: "advanced" as const,
					availableTiers: STANDARD_SERVER,
				},
				{
					configuredTier: "auto" as const,
					availableTiers: STANDARD_SERVER,
					hintedTier: "advanced" as const,
				},
				{
					configuredTier: "auto" as const,
					availableTiers: STANDARD_SERVER,
					preferredTier: "basic" as const,
				},
			];
			for (const input of inputs) {
				const decision = decideTier({ ...input, intakeTierHint: "flash" });
				expect(decision.tier).toBeUndefined();
				expect(decision.reason).toBe("native-document");
			}
		});
	});

	describe("a PDF or an image always names one", () => {
		it("auto sends the best tier the server lists: standard, then basic, then flash", () => {
			for (const [available, expected] of [
				[STANDARD_SERVER, "standard"],
				[BASIC_SERVER, "basic"],
				[FLASH_SERVER, "flash"],
				// Order of the list does not matter, only the ladder does.
				[["standard", "flash", "basic"] as MineruTierId[], "standard"],
			] as const) {
				const decision = decideTier({
					configuredTier: "auto",
					availableTiers: available,
				});
				expect(decision.tier).toBe(expected);
				expect(decision.reason).toBe("auto-best");
			}
		});

		it("never picks advanced for you, even when the server lists it", () => {
			const decision = decideTier({
				configuredTier: "auto",
				availableTiers: [...STANDARD_SERVER, "advanced"],
			});
			expect(decision.tier).toBe("standard");
		});

		it("omits rather than guesses when the tier list could not be read", () => {
			// The one place a PDF goes without a tier: a standard guess against a
			// flash-only server is a permanent 400, and a server that cannot even list
			// its tiers is better asked to choose for itself.
			const decision = decideTier({
				configuredTier: "auto",
				availableTiers: [],
			});
			expect(decision.tier).toBeUndefined();
			expect(decision.reason).toBe("auto-no-tier-list");
		});
	});

	describe("an explicit re-extract tier", () => {
		it("wins over everything when the server offers it", () => {
			const decision = decideTier({
				hintedTier: "basic",
				configuredTier: "flash",
				availableTiers: STANDARD_SERVER,
			});
			expect(decision.tier).toBe("basic");
			expect(decision.reason).toBe("hint-override");
		});

		it("fails before any bytes move when the server lacks it", () => {
			let thrown: unknown;
			try {
				decideTier({
					hintedTier: "standard",
					configuredTier: "auto",
					availableTiers: BASIC_SERVER,
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeTruthy();
			const mapping = mapMineruError(thrown);
			// A 400 "Tier 'standard' is not available" is a misconfiguration, never an
			// outage, and never worth a retry.
			expect(mapping.taxonomy).toBe("tier_unavailable");
			expect(mapping.retryable).toBe(false);
			expect(mapping.rule).toBe("client:tier-not-available");
		});
	});

	// Phase 6 D10. The generated-file readback is the only caller: a PDF this app
	// rendered itself never needs OCR, and a flash parse beats a cold basic one for
	// a file nobody is waiting on.
	describe("a soft preference", () => {
		it("is used when the server offers it", () => {
			const decision = decideTier({
				preferredTier: "flash",
				configuredTier: "auto",
				availableTiers: BASIC_SERVER,
			});
			expect(decision.tier).toBe("flash");
			expect(decision.reason).toBe("hint-preferred");
		});

		it("degrades to the best tier when the server lacks it, it does not throw", () => {
			const decision = decideTier({
				preferredTier: "flash",
				configuredTier: "auto",
				availableTiers: ["basic"],
			});
			expect(decision.tier).toBe("basic");
			expect(decision.reason).toBe("auto-best");
		});

		it("yields to the configured tier only when it is unavailable", () => {
			const decision = decideTier({
				preferredTier: "flash",
				configuredTier: "basic",
				availableTiers: ["basic"],
			});
			expect(decision.tier).toBe("basic");
			expect(decision.reason).toBe("config-explicit");
		});

		it("never softens the hard re-extract tier next to it", () => {
			// A button the user pressed fails loudly; a background preference degrades.
			expect(() =>
				decideTier({
					hintedTier: "standard",
					preferredTier: "flash",
					configuredTier: "auto",
					availableTiers: BASIC_SERVER,
				}),
			).toThrow();
			const decision = decideTier({
				hintedTier: "basic",
				preferredTier: "flash",
				configuredTier: "auto",
				availableTiers: BASIC_SERVER,
			});
			expect(decision.tier).toBe("basic");
			expect(decision.reason).toBe("hint-override");
		});
	});

	describe("the configured tier", () => {
		it("is sent when the server offers it", () => {
			const decision = decideTier({
				configuredTier: "basic",
				availableTiers: BASIC_SERVER,
			});
			expect(decision.tier).toBe("basic");
			expect(decision.reason).toBe("config-explicit");
		});

		it("is tier_unavailable when the server lacks it", () => {
			expect(() =>
				decideTier({
					configuredTier: "advanced",
					availableTiers: STANDARD_SERVER,
				}),
			).toThrow();
			expect(() =>
				decideTier({ configuredTier: "basic", availableTiers: FLASH_SERVER }),
			).toThrow();
		});
	});

	it("never returns null for a tier, on any input", () => {
		const hints = [undefined, "flash" as const];
		const servers = [STANDARD_SERVER, BASIC_SERVER, FLASH_SERVER, []];
		for (const intakeTierHint of hints) {
			for (const availableTiers of servers) {
				for (const configuredTier of ["auto", "flash"] as const) {
					let decision: ReturnType<typeof decideTier> | null = null;
					try {
						decision = decideTier({
							intakeTierHint,
							configuredTier,
							availableTiers,
						});
					} catch {
						// An unavailable configured tier throws; it is never null.
					}
					if (decision === null) continue;
					expect(decision.tier).not.toBeNull();
					if (decision.tier !== undefined) {
						expect(isMineruTierId(decision.tier)).toBe(true);
					}
				}
			}
		}
	});
});

describe("decideOcrMode", () => {
	it("omits the key for auto: ocr_mode:null is a 400 despite the docs", () => {
		expect(decideOcrMode("auto")).toBeUndefined();
	});

	it("sends txt and ocr verbatim", () => {
		expect(decideOcrMode("txt")).toBe("txt");
		expect(decideOcrMode("ocr")).toBe("ocr");
	});
});
