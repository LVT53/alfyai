// The voice design module (spec §4.6; Plan 3, Task 1): the five knobs of a
// personal voice, the words each slider shows, the seven styles, the safe
// ranges of the Zonos controls and the one mapping from knob values to those
// controls.
//
// The browser draws the sliders and their words from this file, and the server
// makes the controls of a reading or a preview with it, so the two cannot
// disagree. It has no imports, because both sides use it.
//
// Knob values are stored as slider values: a number on the 0.05 grid inside
// the knob's range. A Zonos control is made only by `knobsToControls`, and it
// never lies outside `SAFE_CONTROL_RANGES`, so a range that is measured again
// narrows saved voices too.

export type VoiceLanguage = "en" | "hu";

export const KNOB_KEYS = [
	"pace",
	"pitch",
	"depth",
	"energy",
	"projection",
] as const;
export type KnobKey = (typeof KNOB_KEYS)[number];
export type Knobs = Record<KnobKey, number>;

/** Every knob at normal. Frozen: copy it to change it. */
export const ZERO_KNOBS: Knobs = Object.freeze({
	pace: 0,
	pitch: 0,
	depth: 0,
	energy: 0,
	projection: 0,
});

export type KnobSpec = {
	key: KnobKey;
	min: number;
	max: number;
	/** How many words the slider shows. */
	words: number;
	/** Each word's highest value, low to high. The last word has none. */
	wordBounds: readonly number[];
};

/**
 * The sliders, in the order they are drawn: the spec's ranges, and the
 * prototype's `words` functions as the highest value of each word. The
 * prototype writes some bands with `<`, which on the 0.05 grid is `≤` the
 * grid value below (`v < −0.6` is `v ≤ −0.65`).
 */
export const KNOBS: readonly KnobSpec[] = [
	{
		key: "pace",
		min: -2,
		max: 2,
		words: 7,
		wordBounds: [-1.25, -0.65, -0.15, 0.1, 0.6, 1.25],
	},
	{
		key: "pitch",
		min: -2,
		max: 2,
		words: 6,
		wordBounds: [-1.25, -0.65, -0.15, 0.1, 1.25],
	},
	{ key: "depth", min: 0, max: 4, words: 4, wordBounds: [0.1, 1.5, 3] },
	{
		key: "energy",
		min: -4,
		max: 4,
		words: 7,
		wordBounds: [-2.5, -1.25, -0.25, 0.2, 1.2, 2.5],
	},
	{
		key: "projection",
		min: -1.5,
		max: 2,
		words: 7,
		wordBounds: [-0.9, -0.35, -0.15, 0.1, 0.5, 1.2],
	},
];

/** A slider moves in steps of this much. */
export const KNOB_STEP = 0.05;
/** A value within this share of the slider's range snaps to normal. */
export const SNAP_SHARE = 0.04;

const GRID = Math.round(1 / KNOB_STEP);
const toGrid = (value: number): number =>
	Number.isFinite(value) ? Math.round(value * GRID) : Number.NaN;

function specOf(key: KnobKey): KnobSpec {
	const spec = KNOBS.find((knob) => knob.key === key);
	if (!spec) throw new Error(`Unknown knob: ${key}`);
	return spec;
}

export type StyleKey =
	| "original"
	| "bedtime"
	| "storyteller"
	| "brisk"
	| "calmAndClear"
	| "cheerful"
	| "newsreader";

const knobs = (values: Partial<Knobs>): Knobs =>
	Object.freeze({ ...ZERO_KNOBS, ...values });

/** The styles, in the spec's order, with its values (§4.6). */
export const STYLES: readonly { key: StyleKey; knobs: Knobs }[] = [
	{ key: "original", knobs: ZERO_KNOBS },
	{
		key: "bedtime",
		knobs: knobs({ pace: -1, depth: 1, energy: -2.5, projection: -0.6 }),
	},
	{
		key: "storyteller",
		knobs: knobs({ pace: -0.5, energy: 1.5, projection: 0.5 }),
	},
	{ key: "brisk", knobs: knobs({ pace: 1.25, energy: 1, projection: 0.5 }) },
	{
		key: "calmAndClear",
		knobs: knobs({ pace: -0.5, energy: -1.5, projection: 1 }),
	},
	{
		key: "cheerful",
		knobs: knobs({ pace: 0.5, pitch: 0.5, energy: 2.5, projection: 0.5 }),
	},
	{
		key: "newsreader",
		knobs: knobs({ pace: 0.25, depth: 1, energy: -0.5, projection: 1.5 }),
	},
];

export type ControlName =
	| "delivery.tempo"
	| "pitch.pitch"
	| "texture.deep"
	| "mood.arousal"
	| "delivery.whisper"
	| "delivery.loud";

export type SafeRanges = Record<
	VoiceLanguage,
	Record<ControlName, { min: number; max: number }>
>;

/**
 * The range each Zonos control may take, per language. Today both languages
 * hold the spec's ranges (§4.6). `scripts/measure_knobs.py` on the speech
 * service measures them on the box; a range that is measured narrower goes
 * here (Plan 3, Task 15) and clamps the control without moving the slider.
 */
export const SAFE_CONTROL_RANGES: SafeRanges = {
	en: {
		"delivery.tempo": { min: -2, max: 2 },
		"pitch.pitch": { min: -2, max: 2 },
		"texture.deep": { min: 0, max: 4 },
		"mood.arousal": { min: -4, max: 4 },
		"delivery.whisper": { min: 0, max: 1.5 },
		"delivery.loud": { min: 0, max: 2 },
	},
	hu: {
		"delivery.tempo": { min: -2, max: 2 },
		"pitch.pitch": { min: -2, max: 2 },
		"texture.deep": { min: 0, max: 4 },
		"mood.arousal": { min: -4, max: 4 },
		"delivery.whisper": { min: 0, max: 1.5 },
		"delivery.loud": { min: 0, max: 2 },
	},
};

/**
 * A knob value as it is kept: 0 when it is not a finite number, clamped to
 * the slider's range, 0 within `SNAP_SHARE` of the range, rounded to 0.05.
 */
export function snapKnob(key: KnobKey, value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	const spec = specOf(key);
	const clamped = Math.min(spec.max, Math.max(spec.min, value));
	if (Math.abs(clamped) < SNAP_SHARE * (spec.max - spec.min)) return 0;
	const snapped = Math.round(clamped * GRID) / GRID;
	// `=== 0` is also true for -0, which becomes the plain 0 here.
	return snapped === 0 ? 0 : snapped;
}

/**
 * A knob value set by a key step (an arrow, Page Up, an assistive increment)
 * from `previous`. A step of 0.05 from normal lands inside the snap, so a key
 * could never leave normal: a step that would snap back from normal goes on to
 * the first value outside the snap instead. Any other step is `snapKnob`'s, so
 * a step back into the snap is normal again. A drag keeps the soft snap.
 */
export function keyStepKnob(
	key: KnobKey,
	previous: number,
	value: number,
): number {
	const snapped = snapKnob(key, value);
	if (snapped !== 0 || previous !== 0 || !(Math.abs(value) > 0)) return snapped;
	const spec = specOf(key);
	const direction = Math.sign(value);
	for (let step = 1; step * KNOB_STEP <= spec.max - spec.min; step++) {
		const next = snapKnob(key, direction * step * KNOB_STEP);
		if (next !== 0) return next;
	}
	return 0;
}

/**
 * The Zonos controls of a set of knobs, for a language. Each knob is snapped
 * first, and a knob at normal sends nothing. Each control is clamped to the
 * language's safe range and rounded to three decimals.
 */
export function knobsToControls(
	knobs: Knobs,
	language: VoiceLanguage,
	safe: SafeRanges = SAFE_CONTROL_RANGES,
): Partial<Record<ControlName, number>> {
	const controls: Partial<Record<ControlName, number>> = {};
	const send = (name: ControlName, value: number) => {
		const range = safe[language][name];
		const clamped = Math.min(range.max, Math.max(range.min, value));
		const rounded = Math.round(clamped * 1000) / 1000;
		if (Number.isFinite(rounded) && rounded !== 0) controls[name] = rounded;
	};
	send("delivery.tempo", snapKnob("pace", knobs.pace));
	send("pitch.pitch", snapKnob("pitch", knobs.pitch));
	send("texture.deep", snapKnob("depth", knobs.depth));
	send("mood.arousal", snapKnob("energy", knobs.energy));
	const projection = snapKnob("projection", knobs.projection);
	if (projection < 0) send("delivery.whisper", -projection);
	else if (projection > 0) send("delivery.loud", projection);
	return controls;
}

/**
 * The index of the word a slider shows for a value, from 0 (the lowest word)
 * up. It compares on the 0.05 grid, as the prototype's slider does.
 */
export function knobWordIndex(key: KnobKey, value: number): number {
	const spec = specOf(key);
	const at = Number.isFinite(value) ? toGrid(value) : 0;
	const index = spec.wordBounds.findIndex((bound) => at <= toGrid(bound));
	return index === -1 ? spec.wordBounds.length : index;
}

/** The style whose five values the knobs equal, on the 0.05 grid. */
export function matchingStyle(values: Knobs): StyleKey | null {
	const found = STYLES.find((style) =>
		KNOB_KEYS.every((key) => toGrid(style.knobs[key]) === toGrid(values[key])),
	);
	return found ? found.key : null;
}

export type NameParts =
	| { kind: "style"; style: Exclude<StyleKey, "original"> }
	| { kind: "changes"; changes: Array<{ key: KnobKey; word: number }> }
	| { kind: "mine" };

/** A knob names a voice when it moved more than this share of its range. */
const NAME_SHARE = 0.08;
const SHARE_SCALE = 1_000_000;

/**
 * What a new voice is called until the person types (the prototype's
 * `syncName`): the style that matches, else the two biggest changes, else
 * "mine". The words that say it are the interface's.
 */
export function nameParts(values: Knobs): NameParts {
	const style = matchingStyle(values);
	if (style && style !== "original") return { kind: "style", style };
	const moved = KNOBS.map((spec, order) => ({
		spec,
		order,
		// Whole millionths, so a tie is a tie whatever the rounding of the division.
		share: Math.round(
			(Math.abs(values[spec.key]) / (spec.max - spec.min)) * SHARE_SCALE,
		),
	}))
		.filter((entry) => entry.share > NAME_SHARE * SHARE_SCALE)
		.sort((a, b) => b.share - a.share || a.order - b.order)
		.slice(0, 2);
	if (moved.length === 0) return { kind: "mine" };
	return {
		kind: "changes",
		changes: moved.map(({ spec }) => ({
			key: spec.key,
			word: knobWordIndex(spec.key, values[spec.key]),
		})),
	};
}

/** A knob that moved more than this is named under a saved voice. */
const SUMMARY_MOVE = 0.3;

/** The knobs moved by more than 0.3, in `KNOB_KEYS` order ("slower, very calm"). */
export function summaryKnobs(values: Knobs): KnobKey[] {
	return KNOB_KEYS.filter(
		(key) => Math.abs(toGrid(values[key])) > toGrid(SUMMARY_MOVE),
	);
}

export const VOICE_NAME_MAX = 40;

/** A name as it is kept: trimmed, and cut to 40 code points. */
export function clipVoiceName(name: string): string {
	let clipped = "";
	let count = 0;
	for (const character of name.trim()) {
		if (count === VOICE_NAME_MAX) break;
		clipped += character;
		count++;
	}
	return clipped.trimEnd();
}

/** A person keeps at most this many personal voices. */
export const PERSONAL_VOICES_MAX = 50;

/** The speeds a reading may start at (the Default speed). */
export const READING_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function isReadingSpeed(value: unknown): value is number {
	return READING_SPEEDS.some((speed) => speed === value);
}
