/**
 * The tier table of the spec, row by row, against BOTH recorded server shapes:
 * a `--tier basic` server (flash + basic) and a `--tier flash` server.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MineruTierId } from "./config";
import { mapMineruError } from "./errors";
import { mineruHealthSchema, mineruTierListSchema } from "./schemas";
import { MINERU_FIXTURE_ROOT } from "./testing/fake-server";
import {
	assertMineruOutputFormatsSupported,
	decideOcrMode,
	decideTier,
	isMineruTierId,
} from "./tier-policy";

function tiersFrom(file: string): MineruTierId[] {
	const parsed = mineruTierListSchema.parse(
		JSON.parse(readFileSync(join(MINERU_FIXTURE_ROOT, "server", file), "utf8")),
	);
	return parsed.data.map((tier) => tier.id);
}

const BASIC_SERVER = tiersFrom("tiers.json");
const FLASH_SERVER = tiersFrom("flash.tiers.json");

describe("decideTier — the recorded server shapes", () => {
	it("reads both fixtures as the spec describes them", () => {
		expect(BASIC_SERVER).toEqual(["flash", "basic"]);
		expect(FLASH_SERVER).toEqual(["flash"]);
	});

	it("row 1: an explicit re-extract tier wins when the server offers it", () => {
		const decision = decideTier({
			hintedTier: "basic",
			intakeTierHint: "flash",
			configuredTier: "flash",
			availableTiers: BASIC_SERVER,
		});
		expect(decision.tier).toBe("basic");
		expect(decision.reason).toBe("hint-override");
	});

	it("row 1′: an explicit tier the server lacks fails before any bytes move", () => {
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
		// A 400 "Tier 'standard' not available" is a misconfiguration, never an
		// outage — and never worth a retry.
		expect(mapping.taxonomy).toBe("tier_unavailable");
		expect(mapping.retryable).toBe(false);
	});

	// Phase 6 D10. The generated-file readback is the only caller: a PDF this
	// app rendered itself never needs OCR, and 811 ms of flash beats 18 600 ms
	// of a cold basic job for a file nobody is waiting on.
	it("row 1½: a soft preference is used when the server offers it", () => {
		const decision = decideTier({
			preferredTier: "flash",
			configuredTier: "auto",
			availableTiers: BASIC_SERVER,
		});
		// Without the preference this input omits the key (row 4) and the
		// server's start-up tier parses a born-digital PDF at basic.
		expect(decision.tier).toBe("flash");
		expect(decision.reason).toBe("hint-preferred");
		expect(
			decideTier({ configuredTier: "auto", availableTiers: BASIC_SERVER }).tier,
		).toBeUndefined();
	});

	it("row 1″: a soft preference the server lacks degrades, it does not throw", () => {
		const decision = decideTier({
			preferredTier: "flash",
			configuredTier: "auto",
			availableTiers: ["basic"],
		});
		expect(decision.tier).toBeUndefined();
		expect(decision.reason).toBe("auto-quality");
	});

	it("row 1″: the configured tier still wins behind an unavailable preference", () => {
		const decision = decideTier({
			preferredTier: "flash",
			configuredTier: "basic",
			availableTiers: ["basic"],
		});
		expect(decision.tier).toBe("basic");
		expect(decision.reason).toBe("config-explicit");
	});

	it("keeps the hard re-extract tier hard even next to a preference", () => {
		// The two keys must never be conflated: a button the user pressed fails
		// loudly, a background preference degrades.
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

	it("row 2: a flash-hinted format asks for flash on either server", () => {
		for (const available of [BASIC_SERVER, FLASH_SERVER]) {
			const decision = decideTier({
				intakeTierHint: "flash",
				configuredTier: "auto",
				availableTiers: available,
			});
			expect(decision.tier).toBe("flash");
			expect(decision.reason).toBe("hint-flash");
		}
	});

	it("row 3: the configured tier is sent when the server offers it", () => {
		const decision = decideTier({
			configuredTier: "basic",
			availableTiers: BASIC_SERVER,
		});
		expect(decision.tier).toBe("basic");
		expect(decision.reason).toBe("config-explicit");
	});

	it("row 3′: a configured tier the server lacks is tier_unavailable", () => {
		expect(() =>
			decideTier({ configuredTier: "advanced", availableTiers: BASIC_SERVER }),
		).toThrow();
		expect(() =>
			decideTier({ configuredTier: "basic", availableTiers: FLASH_SERVER }),
		).toThrow();
	});

	it("row 4: auto on a quality server OMITS the key entirely", () => {
		const decision = decideTier({
			configuredTier: "auto",
			availableTiers: BASIC_SERVER,
		});
		expect(decision.tier).toBeUndefined();
		expect(decision.reason).toBe("auto-quality");
		// Omission, not null: `tier: null` is a 400 (and a 503 on flash-only).
		expect(buildBody(decision.tier)).not.toHaveProperty("tier");
	});

	it("row 5: auto on a flash-only server sends flash explicitly", () => {
		const decision = decideTier({
			configuredTier: "auto",
			availableTiers: FLASH_SERVER,
		});
		// Omitting here is a 503 quality_tier_unavailable for PDF and images.
		expect(decision.tier).toBe("flash");
		expect(decision.reason).toBe("auto-flash-only");
	});

	it("omits rather than guesses when the tier list could not be read", () => {
		const decision = decideTier({ configuredTier: "auto", availableTiers: [] });
		expect(decision.tier).toBeUndefined();
		expect(decision.reason).toBe("auto-quality");
	});

	it("falls through the flash hint on a server without a flash tier", () => {
		const decision = decideTier({
			intakeTierHint: "flash",
			configuredTier: "auto",
			availableTiers: ["basic"],
		});
		expect(decision.tier).toBeUndefined();
		expect(decision.reason).toBe("auto-quality");
	});

	it("never returns null for a tier, on any input", () => {
		const inputs = [
			{ configuredTier: "auto" as const, availableTiers: BASIC_SERVER },
			{ configuredTier: "auto" as const, availableTiers: FLASH_SERVER },
			{ configuredTier: "flash" as const, availableTiers: BASIC_SERVER },
			{
				configuredTier: "auto" as const,
				availableTiers: BASIC_SERVER,
				intakeTierHint: "flash" as const,
			},
			{
				configuredTier: "auto" as const,
				availableTiers: BASIC_SERVER,
				hintedTier: "basic" as const,
			},
			{
				configuredTier: "auto" as const,
				availableTiers: BASIC_SERVER,
				preferredTier: "flash" as const,
			},
			{
				configuredTier: "auto" as const,
				availableTiers: ["basic" as const],
				preferredTier: "flash" as const,
			},
		];
		for (const input of inputs) {
			const decision = decideTier(input);
			expect(decision.tier).not.toBeNull();
			if (decision.tier !== undefined) {
				expect(isMineruTierId(decision.tier)).toBe(true);
			}
		}
	});
});

describe("decideOcrMode", () => {
	it("omits the key for auto — ocr_mode:null is a 400 despite the docs", () => {
		expect(decideOcrMode("auto")).toBeUndefined();
		expect(buildBody(undefined, decideOcrMode("auto"))).not.toHaveProperty(
			"ocr_mode",
		);
	});

	it("sends txt and ocr verbatim", () => {
		expect(decideOcrMode("txt")).toBe("txt");
		expect(decideOcrMode("ocr")).toBe("ocr");
	});
});

describe("assertMineruOutputFormatsSupported", () => {
	const health = mineruHealthSchema.parse(
		JSON.parse(
			readFileSync(join(MINERU_FIXTURE_ROOT, "server", "health.json"), "utf8"),
		),
	);

	it("passes for the four formats every fixture requested", () => {
		expect(() =>
			assertMineruOutputFormatsSupported(
				["markdown", "middle_json", "structured_content", "zip"],
				health.features?.output_formats ?? [],
			),
		).not.toThrow();
	});

	it("fails fast, non-retryably, for a format the server cannot produce", () => {
		let thrown: unknown;
		try {
			assertMineruOutputFormatsSupported(
				["markdown", "docx"],
				health.features?.output_formats ?? [],
			);
		} catch (error) {
			thrown = error;
		}
		const mapping = mapMineruError(thrown);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(false);
		expect(mapping.rule).toBe("400:unsupported_output_format");
	});

	it("says nothing when the server advertised no formats at all", () => {
		expect(() =>
			assertMineruOutputFormatsSupported(["markdown"], []),
		).not.toThrow();
	});
});

/** The `tier`/`ocr_mode` half of a job body, built the way `createJob` does. */
function buildBody(
	tier?: MineruTierId,
	ocrMode?: "txt" | "ocr",
): Record<string, unknown> {
	const body: Record<string, unknown> = { files: [], output_formats: [] };
	if (tier !== undefined) body.tier = tier;
	if (ocrMode !== undefined) body.ocr_mode = ocrMode;
	return body;
}
