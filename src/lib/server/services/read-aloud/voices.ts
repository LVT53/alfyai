// The built-in voices of read aloud: configuration in code, one entry per voice
// (spec §4.5). Plan 3 adds the person's choice and personal voices on top of
// this list; until then every reading uses the default voice of its language.

export type VoiceLanguage = "en" | "hu";

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

/** The voice a reading in `language` uses, until Plan 3 adds a choice. */
export function defaultVoiceFor(language: VoiceLanguage): BuiltInVoice {
	const key = language === "en" ? "imogen" : "berta";
	return BUILT_IN_VOICES.find((voice) => voice.key === key) as BuiltInVoice;
}
