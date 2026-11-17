import { describe, expect, it } from "vitest";
import {
	clipVoiceName,
	isReadingSpeed,
	KNOB_KEYS,
	KNOB_STEP,
	KNOBS,
	type KnobKey,
	type Knobs,
	keyStepKnob,
	knobsToControls,
	knobWordIndex,
	matchingStyle,
	nameParts,
	PERSONAL_VOICES_MAX,
	READING_SPEEDS,
	SAFE_CONTROL_RANGES,
	type SafeRanges,
	SNAP_SHARE,
	STYLES,
	snapKnob,
	summaryKnobs,
	VOICE_NAME_MAX,
	type VoiceLanguage,
	ZERO_KNOBS,
} from "./voice-knobs";

const only = (patch: Partial<Knobs>): Knobs => ({ ...ZERO_KNOBS, ...patch });
const style = (key: string): Knobs => {
	const found = STYLES.find((candidate) => candidate.key === key);
	if (!found) throw new Error(`no style ${key}`);
	return found.knobs;
};

describe("the five knobs", () => {
	it("holds the spec's five sliders, in order, with their ranges", () => {
		expect([...KNOB_KEYS]).toEqual([
			"pace",
			"pitch",
			"depth",
			"energy",
			"projection",
		]);
		expect(KNOBS.map((knob) => knob.key)).toEqual([...KNOB_KEYS]);
		expect(
			KNOBS.map((knob) => [knob.key, knob.min, knob.max, knob.words]),
		).toEqual([
			["pace", -2, 2, 7],
			["pitch", -2, 2, 6],
			["depth", 0, 4, 4],
			["energy", -4, 4, 7],
			["projection", -1.5, 2, 7],
		]);
		for (const knob of KNOBS) {
			expect(knob.wordBounds).toHaveLength(knob.words - 1);
			expect([...knob.wordBounds].sort((a, b) => a - b)).toEqual([
				...knob.wordBounds,
			]);
		}
		expect(KNOB_STEP).toBe(0.05);
		expect(SNAP_SHARE).toBe(0.04);
		expect(ZERO_KNOBS).toEqual({
			pace: 0,
			pitch: 0,
			depth: 0,
			energy: 0,
			projection: 0,
		});
	});

	it("holds the seven styles with the spec's values", () => {
		expect(STYLES.map((s) => [s.key, s.knobs])).toEqual([
			["original", { pace: 0, pitch: 0, depth: 0, energy: 0, projection: 0 }],
			[
				"bedtime",
				{ pace: -1, pitch: 0, depth: 1, energy: -2.5, projection: -0.6 },
			],
			[
				"storyteller",
				{ pace: -0.5, pitch: 0, depth: 0, energy: 1.5, projection: 0.5 },
			],
			["brisk", { pace: 1.25, pitch: 0, depth: 0, energy: 1, projection: 0.5 }],
			[
				"calmAndClear",
				{ pace: -0.5, pitch: 0, depth: 0, energy: -1.5, projection: 1 },
			],
			[
				"cheerful",
				{ pace: 0.5, pitch: 0.5, depth: 0, energy: 2.5, projection: 0.5 },
			],
			[
				"newsreader",
				{ pace: 0.25, pitch: 0, depth: 1, energy: -0.5, projection: 1.5 },
			],
		]);
	});

	it("keeps the limits the plan fixes", () => {
		expect(VOICE_NAME_MAX).toBe(40);
		expect(PERSONAL_VOICES_MAX).toBe(50);
		expect([...READING_SPEEDS]).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
	});

	it("accepts only the six reading speeds", () => {
		for (const speed of READING_SPEEDS)
			expect(isReadingSpeed(speed)).toBe(true);
		for (const other of [0.5, 0, 3, 1.1, "1", null, undefined, Number.NaN]) {
			expect(isReadingSpeed(other)).toBe(false);
		}
	});
});

describe("making Zonos controls from knobs", () => {
	// The listening pack's controls (2026-11-16), the same in both languages.
	const APPROVED: Array<[string, Record<string, number>]> = [
		["original", {}],
		[
			"bedtime",
			{
				"delivery.tempo": -1,
				"texture.deep": 1,
				"mood.arousal": -2.5,
				"delivery.whisper": 0.6,
			},
		],
		[
			"storyteller",
			{ "delivery.tempo": -0.5, "mood.arousal": 1.5, "delivery.loud": 0.5 },
		],
		[
			"brisk",
			{ "delivery.tempo": 1.25, "mood.arousal": 1, "delivery.loud": 0.5 },
		],
		[
			"calmAndClear",
			{ "delivery.tempo": -0.5, "mood.arousal": -1.5, "delivery.loud": 1 },
		],
		[
			"cheerful",
			{
				"delivery.tempo": 0.5,
				"pitch.pitch": 0.5,
				"mood.arousal": 2.5,
				"delivery.loud": 0.5,
			},
		],
		[
			"newsreader",
			{
				"delivery.tempo": 0.25,
				"texture.deep": 1,
				"mood.arousal": -0.5,
				"delivery.loud": 1.5,
			},
		],
	];

	it("maps each style to the controls the owner approved on the box", () => {
		for (const language of ["en", "hu"] as VoiceLanguage[]) {
			for (const [key, controls] of APPROVED) {
				expect(
					knobsToControls(style(key), language),
					`${key} in ${language}`,
				).toEqual(controls);
			}
		}
	});

	it("sends Projection below normal as whisper and above it as loud", () => {
		expect(knobsToControls(only({ projection: -1.5 }), "hu")).toEqual({
			"delivery.whisper": 1.5,
		});
		expect(knobsToControls(only({ projection: 2 }), "en")).toEqual({
			"delivery.loud": 2,
		});
		expect(knobsToControls(ZERO_KNOBS, "en")).toEqual({});
		// Measured on the box (2026-11-17): English breathiness stops at 1.
		expect(knobsToControls(only({ projection: -1.5 }), "en")).toEqual({
			"delivery.whisper": 1,
		});
	});

	it("clamps each control to a narrower safe range of its language", () => {
		// The spec's ranges, so this test pins the clamping and not the measured values.
		const spec: SafeRanges["en"] = {
			"delivery.tempo": { min: -2, max: 2 },
			"pitch.pitch": { min: -2, max: 2 },
			"texture.deep": { min: 0, max: 4 },
			"mood.arousal": { min: -4, max: 4 },
			"delivery.whisper": { min: 0, max: 1.5 },
			"delivery.loud": { min: 0, max: 2 },
		};
		const narrower: SafeRanges = {
			en: spec,
			hu: {
				...spec,
				"delivery.tempo": { min: -1.5, max: 1 },
				"delivery.whisper": { min: 0, max: 1 },
			},
		};
		expect(knobsToControls(only({ pace: 2 }), "hu", narrower)).toEqual({
			"delivery.tempo": 1,
		});
		expect(knobsToControls(only({ pace: -2 }), "hu", narrower)).toEqual({
			"delivery.tempo": -1.5,
		});
		expect(knobsToControls(only({ pace: -1 }), "hu", narrower)).toEqual({
			"delivery.tempo": -1,
		});
		expect(knobsToControls(only({ projection: -1.5 }), "hu", narrower)).toEqual(
			{
				"delivery.whisper": 1,
			},
		);
		// The same knobs in English are unchanged.
		expect(knobsToControls(only({ pace: 2 }), "en", narrower)).toEqual({
			"delivery.tempo": 2,
		});
		expect(knobsToControls(only({ projection: -1.5 }), "en", narrower)).toEqual(
			{
				"delivery.whisper": 1.5,
			},
		);
	});

	it("clamps a stored value beyond its slider and ignores a value that is not a number", () => {
		expect(knobsToControls(only({ pace: 7 }), "en")).toEqual({
			"delivery.tempo": 2,
		});
		expect(knobsToControls(only({ energy: -9 }), "en")).toEqual({
			"mood.arousal": -4,
		});
		expect(
			knobsToControls(
				{
					pace: Number.NaN,
					pitch: Number.POSITIVE_INFINITY,
					depth: "3" as unknown as number,
					energy: Number.NEGATIVE_INFINITY,
					projection: undefined as unknown as number,
				},
				"en",
			),
		).toEqual({});
	});

	it("never lets a control lie outside the safe ranges, whatever the knobs hold", () => {
		const extreme: Knobs = {
			pace: 99,
			pitch: -99,
			depth: 99,
			energy: 99,
			projection: -99,
		};
		for (const language of ["en", "hu"] as VoiceLanguage[]) {
			const controls = knobsToControls(extreme, language);
			for (const [name, value] of Object.entries(controls)) {
				const range =
					SAFE_CONTROL_RANGES[language][name as keyof SafeRanges["en"]];
				expect(value).toBeGreaterThanOrEqual(range.min);
				expect(value).toBeLessThanOrEqual(range.max);
			}
		}
	});

	it("keeps every safe range inside the spec's and around normal", () => {
		const spec = {
			"delivery.tempo": [-2, 2],
			"pitch.pitch": [-2, 2],
			"texture.deep": [0, 4],
			"mood.arousal": [-4, 4],
			"delivery.whisper": [0, 1.5],
			"delivery.loud": [0, 2],
		} as const;
		for (const language of ["en", "hu"] as VoiceLanguage[]) {
			for (const [name, [min, max]] of Object.entries(spec)) {
				const range =
					SAFE_CONTROL_RANGES[language][name as keyof SafeRanges["en"]];
				expect(range.min, `${language} ${name} min`).toBeGreaterThanOrEqual(
					min,
				);
				expect(range.max, `${language} ${name} max`).toBeLessThanOrEqual(max);
				expect(range.min, `${language} ${name}`).toBeLessThanOrEqual(0);
				expect(range.max, `${language} ${name}`).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

describe("snapping a knob", () => {
	it("snaps to normal within 4% of the range and rounds to 0.05", () => {
		expect(snapKnob("pace", 0.15)).toBe(0);
		expect(snapKnob("pace", 0.2)).toBe(0.2);
		expect(snapKnob("energy", 0.3)).toBe(0);
		expect(snapKnob("energy", 0.35)).toBe(0.35);
		expect(snapKnob("projection", 0.1)).toBe(0);
		expect(snapKnob("pace", 1.234)).toBe(1.25);
		expect(snapKnob("pitch", 9)).toBe(2);
		expect(snapKnob("depth", -1)).toBe(0);
	});

	it("is 0 for a value that is not a finite number, and never -0", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "2", null, {}]) {
			expect(snapKnob("pace", bad as unknown as number)).toBe(0);
		}
		expect(Object.is(snapKnob("pace", -0.1), 0)).toBe(true);
		expect(Object.is(snapKnob("pace", -0), 0)).toBe(true);
	});

	it("leaves a value that is already on the grid as it is", () => {
		for (const knob of KNOBS) {
			for (
				let step = Math.round(knob.min * 20);
				step <= knob.max * 20;
				step++
			) {
				const value = step / 20;
				const snapped = snapKnob(knob.key, value);
				const near = Math.abs(value) < (knob.max - knob.min) * SNAP_SHARE;
				expect(snapped, `${knob.key} ${value}`).toBe(near ? 0 : value);
			}
		}
	});
});

describe("a key step on a knob", () => {
	it("leaves normal in one press: a step that would snap back goes to the first value outside", () => {
		expect(keyStepKnob("pace", 0, 0.05)).toBe(0.2);
		expect(keyStepKnob("pace", 0, -0.05)).toBe(-0.2);
		expect(keyStepKnob("energy", 0, 0.05)).toBe(0.35);
		expect(keyStepKnob("projection", 0, -0.05)).toBe(-0.15);
		expect(keyStepKnob("depth", 0, 0.05)).toBe(0.2);
		// Depth has no lower side: a step down from normal stays there.
		expect(keyStepKnob("depth", 0, -0.05)).toBe(0);
		for (const knob of KNOBS)
			for (const sign of [1, -1]) {
				if (sign < 0 && knob.min >= 0) continue;
				const next = keyStepKnob(knob.key, 0, sign * KNOB_STEP);
				expect(Math.sign(next), `${knob.key} ${sign}`).toBe(sign);
				// The first value on the grid that does not snap: one step less would.
				expect(snapKnob(knob.key, next - sign * KNOB_STEP)).toBe(0);
			}
	});

	it("steps back into normal, and is a plain step everywhere else", () => {
		expect(keyStepKnob("pace", 0.2, 0.15)).toBe(0);
		expect(keyStepKnob("pace", 0.2, 0.25)).toBe(0.25);
		expect(keyStepKnob("energy", -1, -1.05)).toBe(-1.05);
		// A larger step (Page Up) that is outside already is kept.
		expect(keyStepKnob("pace", 0, 0.4)).toBe(0.4);
		expect(keyStepKnob("pace", 0, Number.NaN)).toBe(0);
	});
});

describe("the words of a knob", () => {
	it("names each band as the prototype does", () => {
		const expected: Record<KnobKey, Array<[number, number]>> = {
			pace: [
				[-1.25, 0],
				[-1.2, 1],
				[-0.65, 1],
				[-0.6, 2],
				[-0.15, 2],
				[-0.1, 3],
				[0.1, 3],
				[0.15, 4],
				[0.6, 4],
				[0.65, 5],
				[1.25, 5],
				[1.3, 6],
			],
			pitch: [
				[1.25, 4],
				[1.3, 5],
			],
			depth: [
				[0, 0],
				[0.15, 1],
				[1.5, 1],
				[1.55, 2],
				[3, 2],
				[3.05, 3],
			],
			energy: [
				[-2.5, 0],
				[-2.45, 1],
				[-1.25, 1],
				[-1.2, 2],
				[-0.25, 2],
				[-0.2, 3],
				[0.2, 3],
				[0.25, 4],
				[1.2, 4],
				[1.25, 5],
				[2.5, 5],
				[2.55, 6],
			],
			projection: [
				[-0.9, 0],
				[-0.85, 1],
				[-0.35, 1],
				[-0.3, 2],
				[-0.15, 2],
				[-0.1, 3],
				[0.1, 3],
				[0.15, 4],
				[0.5, 4],
				[0.55, 5],
				[1.2, 5],
				[1.25, 6],
			],
		};
		for (const [key, cases] of Object.entries(expected)) {
			for (const [value, word] of cases) {
				expect(knobWordIndex(key as KnobKey, value), `${key} ${value}`).toBe(
					word,
				);
			}
		}
	});

	it("agrees with the prototype's word functions at every value of every slider", () => {
		// The prototype's `words` functions (voice-editor-prototype.html, KNOBS),
		// written as the index of the word they pick.
		const prototype: Record<KnobKey, (v: number) => number> = {
			pace: (v) =>
				v <= -1.25
					? 0
					: v < -0.6
						? 1
						: v < -0.1
							? 2
							: v <= 0.1
								? 3
								: v <= 0.6
									? 4
									: v <= 1.25
										? 5
										: 6,
			pitch: (v) =>
				v <= -1.25
					? 0
					: v < -0.6
						? 1
						: v < -0.1
							? 2
							: v <= 0.1
								? 3
								: v <= 1.25
									? 4
									: 5,
			depth: (v) => (v <= 0.1 ? 0 : v <= 1.5 ? 1 : v <= 3 ? 2 : 3),
			energy: (v) =>
				v <= -2.5
					? 0
					: v < -1.2
						? 1
						: v < -0.2
							? 2
							: v <= 0.2
								? 3
								: v <= 1.2
									? 4
									: v <= 2.5
										? 5
										: 6,
			projection: (v) =>
				v <= -0.9
					? 0
					: v < -0.3
						? 1
						: v < -0.1
							? 2
							: v <= 0.1
								? 3
								: v <= 0.5
									? 4
									: v <= 1.2
										? 5
										: 6,
		};
		for (const knob of KNOBS) {
			for (
				let step = Math.round(knob.min * 20);
				step <= knob.max * 20;
				step++
			) {
				const value = step / 20;
				expect(knobWordIndex(knob.key, value), `${knob.key} ${value}`).toBe(
					prototype[knob.key](value),
				);
			}
		}
	});
});

describe("styles and names", () => {
	it("finds the style the knobs match", () => {
		expect(matchingStyle(ZERO_KNOBS)).toBe("original");
		expect(matchingStyle(style("bedtime"))).toBe("bedtime");
		expect(matchingStyle({ ...style("bedtime"), pace: -0.95 })).toBeNull();
		expect(matchingStyle(style("newsreader"))).toBe("newsreader");
	});

	it("suggests a style, the two biggest changes or none", () => {
		expect(nameParts(style("bedtime"))).toEqual({
			kind: "style",
			style: "bedtime",
		});
		expect(nameParts(only({ pace: -1, energy: -3 }))).toEqual({
			kind: "changes",
			changes: [
				{ key: "energy", word: 0 },
				{ key: "pace", word: 1 },
			],
		});
		// A tie at 0.15 of the range: pace comes first.
		expect(nameParts(only({ pace: -0.6, energy: 1.2 }))).toEqual({
			kind: "changes",
			changes: [
				{ key: "pace", word: 2 },
				{ key: "energy", word: 4 },
			],
		});
		// 0.075 of the range is not enough.
		expect(nameParts(only({ depth: 0.3 }))).toEqual({ kind: "mine" });
		expect(nameParts(ZERO_KNOBS)).toEqual({ kind: "mine" });
		// Three changes keep the two biggest, the biggest first: projection moved
		// 1.5 of 3.5 (0.43), energy 3 of 8 (0.375), pace 1 of 4 (0.25).
		expect(nameParts(only({ pace: -1, energy: -3, projection: 1.5 }))).toEqual({
			kind: "changes",
			changes: [
				{ key: "projection", word: 6 },
				{ key: "energy", word: 0 },
			],
		});
	});

	it("summarises the knobs moved by more than 0.3", () => {
		expect(summaryKnobs(style("bedtime"))).toEqual([
			"pace",
			"depth",
			"energy",
			"projection",
		]);
		expect(summaryKnobs(only({ pitch: 0.3, pace: 0.35 }))).toEqual(["pace"]);
		expect(summaryKnobs(ZERO_KNOBS)).toEqual([]);
	});

	it("cuts a name to 40 code points", () => {
		expect(clipVoiceName(`  ${"é".repeat(45)}`)).toBe("é".repeat(40));
		expect(Array.from(clipVoiceName("😀".repeat(45)))).toHaveLength(40);
		expect(clipVoiceName("  Test Voice  ")).toBe("Test Voice");
		expect(clipVoiceName("   ")).toBe("");
	});
});
