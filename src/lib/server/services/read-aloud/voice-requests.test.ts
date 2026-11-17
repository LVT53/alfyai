// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import {
	knobsSchema,
	preferencesSchema,
	previewRequestSchema,
	voiceDraftSchema,
	voicePatchSchema,
} from "./voice-requests";

describe("knobsSchema", () => {
	it("takes five finite numbers inside their sliders, the ends included", () => {
		expect(knobsSchema.safeParse({ ...ZERO_KNOBS }).success).toBe(true);
		expect(
			knobsSchema.safeParse({
				pace: -2,
				pitch: 2,
				depth: 4,
				energy: -4,
				projection: 2,
			}).success,
		).toBe(true);
		expect(
			knobsSchema.safeParse({
				pace: 2,
				pitch: -2,
				depth: 0,
				energy: 4,
				projection: -1.5,
			}).success,
		).toBe(true);
	});

	it("refuses a value beyond its slider, one that is not a finite number, a missing key and an extra one", () => {
		const refused: unknown[] = [
			{ ...ZERO_KNOBS, pace: 2.0001 },
			{ ...ZERO_KNOBS, projection: -1.51 },
			{ ...ZERO_KNOBS, depth: -0.0001 },
			{ ...ZERO_KNOBS, energy: 1e9 },
			{ ...ZERO_KNOBS, pace: Number.NaN },
			{ ...ZERO_KNOBS, pace: Number.POSITIVE_INFINITY },
			{ ...ZERO_KNOBS, pace: "0" },
			{ ...ZERO_KNOBS, pace: null },
			{ ...ZERO_KNOBS, pace: undefined },
			{ pace: 0, pitch: 0, depth: 0, energy: 0 },
			{ ...ZERO_KNOBS, gender: 0 },
			null,
			[],
			"normal",
		];
		for (const value of refused) {
			expect(knobsSchema.safeParse(value).success, JSON.stringify(value)).toBe(
				false,
			);
		}
	});
});

describe("voiceDraftSchema and voicePatchSchema", () => {
	const draft = {
		name: "Test Voice",
		base: "imogen",
		knobs: { ...ZERO_KNOBS },
	};

	it("takes a name of 1 to 40 code points after trimming, an emoji counted as one", () => {
		expect(voiceDraftSchema.safeParse(draft).success).toBe(true);
		expect(
			voiceDraftSchema.safeParse({ ...draft, name: "  a  " }).success,
		).toBe(true);
		expect(
			voiceDraftSchema.safeParse({ ...draft, name: "😀".repeat(40) }).success,
		).toBe(true);
		expect(
			voiceDraftSchema.safeParse({ ...draft, name: "x".repeat(40) }).success,
		).toBe(true);
		for (const name of [
			"",
			"   ",
			"x".repeat(41),
			"😀".repeat(41),
			` ${"x".repeat(41)} `,
			"x".repeat(5000),
		]) {
			expect(
				voiceDraftSchema.safeParse({ ...draft, name }).success,
				name.slice(0, 20),
			).toBe(false);
		}
	});

	it("takes a base of 1 to 40 characters, and no other person's field", () => {
		expect(voiceDraftSchema.safeParse({ ...draft, base: "" }).success).toBe(
			false,
		);
		expect(
			voiceDraftSchema.safeParse({ ...draft, base: "x".repeat(41) }).success,
		).toBe(false);
		const parsed = voiceDraftSchema.parse({
			...draft,
			userId: "user-b",
			id: "x",
		});
		expect(Object.keys(parsed).sort()).toEqual(["base", "knobs", "name"]);
	});

	it("takes a patch with at least one field, each field as in a draft", () => {
		expect(voicePatchSchema.safeParse({}).success).toBe(false);
		expect(voicePatchSchema.safeParse({ userId: "user-b" }).success).toBe(
			false,
		);
		expect(voicePatchSchema.safeParse({ name: "New" }).success).toBe(true);
		expect(voicePatchSchema.safeParse({ base: "rupert" }).success).toBe(true);
		expect(
			voicePatchSchema.safeParse({ knobs: { ...ZERO_KNOBS } }).success,
		).toBe(true);
		expect(voicePatchSchema.safeParse({ name: "" }).success).toBe(false);
		expect(voicePatchSchema.safeParse({ knobs: { pace: 1 } }).success).toBe(
			false,
		);
	});
});

describe("preferencesSchema", () => {
	it("takes at least one of a choice for each language and one of the six speeds", () => {
		expect(preferencesSchema.safeParse({}).success).toBe(false);
		expect(preferencesSchema.safeParse({ en: "rupert" }).success).toBe(true);
		expect(
			preferencesSchema.safeParse({ hu: "imre", defaultSpeed: 1.25 }).success,
		).toBe(true);
		for (const defaultSpeed of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
			expect(
				preferencesSchema.safeParse({ defaultSpeed }).success,
				String(defaultSpeed),
			).toBe(true);
		}
		for (const defaultSpeed of [0, 0.5, 1.1, 2.5, "1", null, Number.NaN]) {
			expect(
				preferencesSchema.safeParse({ defaultSpeed }).success,
				String(defaultSpeed),
			).toBe(false);
		}
		expect(preferencesSchema.safeParse({ en: "" }).success).toBe(false);
		expect(preferencesSchema.safeParse({ en: "x".repeat(101) }).success).toBe(
			false,
		);
		expect(preferencesSchema.safeParse({ en: 5 }).success).toBe(false);
	});
});

describe("previewRequestSchema", () => {
	const request = { base: "imogen", knobs: { ...ZERO_KNOBS } };

	it("takes a base, knobs and, as an option, words of up to 2000 characters", () => {
		expect(previewRequestSchema.safeParse(request).success).toBe(true);
		expect(
			previewRequestSchema.safeParse({ ...request, text: "Hello there." })
				.success,
		).toBe(true);
		expect(
			previewRequestSchema.safeParse({ ...request, text: "x".repeat(2000) })
				.success,
		).toBe(true);
		expect(
			previewRequestSchema.safeParse({ ...request, text: "x".repeat(2001) })
				.success,
		).toBe(false);
		expect(
			previewRequestSchema.safeParse({ ...request, text: 7 }).success,
		).toBe(false);
		expect(
			previewRequestSchema.safeParse({ ...request, base: "" }).success,
		).toBe(false);
		expect(
			previewRequestSchema.safeParse({ ...request, base: "x".repeat(41) })
				.success,
		).toBe(false);
		expect(previewRequestSchema.safeParse({ base: "imogen" }).success).toBe(
			false,
		);
		expect(
			previewRequestSchema.safeParse({
				...request,
				knobs: { ...ZERO_KNOBS, pace: 5 },
			}).success,
		).toBe(false);
	});
});
