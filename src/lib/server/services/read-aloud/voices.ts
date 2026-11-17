// The built-in voices of read aloud: configuration in code, one entry per voice
// (spec §4.5). A person's own voices are made from them (`personal-voices.ts`,
// Plan 3): a reading uses the voice the person chose for its language, and the
// language's default when they chose none.

import {
	type Knobs,
	knobsToControls,
	type VoiceLanguage,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";

export type { VoiceLanguage } from "$lib/shared/read-aloud/voice-knobs";

export type BuiltInVoice = {
	key: string;
	name: string;
	language: VoiceLanguage;
	/** The Zonos speaker id on the box. */
	speakerId: string;
	/** Zonos controls sent with every sentence, passed through unchanged. */
	controls: Record<string, number>;
	/** The voice's speaking rate in written characters per second: the estimate before a sentence is made. */
	charsPerSecond: number;
};

// An id is `default_` and the first 16 hex digits of the SHA-1 of the voice
// file's path inside Zonos's voices folder, so the same ids hold on the Mac and
// on the box. The four English ids come from the box; Berta's and Imre's are
// the ones `deploy/speech-service/README.md` lists. Plan 1's Task 8 confirms
// them against the box's `GET /v2/speakers` when it copies the two voices in.
// A Hungarian voice is made in embedding mode with `room.clean: 2` ("studio")
// as its default control (spec §8).
export const BUILT_IN_VOICES: readonly BuiltInVoice[] = [
	{
		key: "imogen",
		name: "Imogen",
		language: "en",
		speakerId: "default_b78b28baf5c31a1d",
		controls: {},
		charsPerSecond: 15,
	},
	{
		key: "rupert",
		name: "Rupert",
		language: "en",
		speakerId: "default_3765f0d1140c05c0",
		controls: {},
		charsPerSecond: 15,
	},
	{
		key: "savannah",
		name: "Savannah",
		language: "en",
		speakerId: "default_de4d191ca7574982",
		controls: {},
		charsPerSecond: 15,
	},
	{
		key: "wyatt",
		name: "Wyatt",
		language: "en",
		speakerId: "default_34370fd91e3484ef",
		controls: {},
		charsPerSecond: 15,
	},
	{
		key: "berta",
		name: "Berta",
		language: "hu",
		speakerId: "default_bf7632822e6b4dc0",
		controls: { "room.clean": 2 },
		charsPerSecond: 15,
	},
	{
		key: "imre",
		name: "Imre",
		language: "hu",
		speakerId: "default_fde02d0881bd267d",
		controls: { "room.clean": 2 },
		charsPerSecond: 15,
	},
];

/**
 * A built-in voice taken out of `BUILT_IN_VOICES` moves here, so that a
 * personal voice made from it can still be named ("Based on Oldie") while it
 * reads with its language's default voice (Plan 3, Decision 14). Empty today.
 */
export const RETIRED_BUILT_IN_VOICES: Readonly<
	Record<string, { name: string; language: VoiceLanguage }>
> = {};

/** The built-in voice with this key, or null. The key is looked up, never read off an object. */
export function builtInVoice(key: string): BuiltInVoice | null {
	return BUILT_IN_VOICES.find((voice) => voice.key === key) ?? null;
}

/** The voice a reading in `language` uses when the person has chosen none, and when their choice is gone. */
export function defaultVoiceFor(language: VoiceLanguage): BuiltInVoice {
	const key = language === "en" ? "imogen" : "berta";
	return BUILT_IN_VOICES.find((voice) => voice.key === key) as BuiltInVoice;
}

/** A voice as a reading or a preview sends it: the speaker, the controls and the speaking rate. */
export type ResolvedVoice = {
	speakerId: string;
	controls: Record<string, number>;
	charsPerSecond: number;
};

/**
 * A built-in voice with a person's knobs on top: the voice's own controls,
 * then the controls the knobs make for its language (clamped to the language's
 * safe ranges by `knobsToControls`). The result owns its controls object.
 */
export function resolvedVoice(
	voice: BuiltInVoice,
	knobs: Knobs = ZERO_KNOBS,
): ResolvedVoice {
	const controls: Record<string, number> = { ...voice.controls };
	for (const [name, value] of Object.entries(
		knobsToControls(knobs, voice.language),
	)) {
		if (value !== undefined) controls[name] = value;
	}
	return {
		speakerId: voice.speakerId,
		controls,
		charsPerSecond: voice.charsPerSecond,
	};
}
