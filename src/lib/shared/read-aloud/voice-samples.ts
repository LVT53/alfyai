// The two samples of the voice editor and Settings (spec §4.6; Plan 3, Task 1):
// two sentences per language, the second a question so that intonation is
// audible, and the check on the words a person types to hear instead.
//
// The English sentences are the prototype's. The Hungarian ones are the two
// sentences the owner approved on the box on 2026-11-16 with Berta and Imre
// (the listening pack's "hu6"). They are spoken by the speech service and
// never sent to a model.

import type { VoiceLanguage } from "./voice-knobs";

export const VOICE_SAMPLES: Record<VoiceLanguage, readonly [string, string]> = {
	en: [
		"Here's the short version: feed it once a day, keep it somewhere warm, and it will double in about six hours.",
		"Shall I read you the long one?",
	],
	hu: [
		"Röviden: ha minden nap eteted, és meleg helyen tartod, körülbelül hat óra alatt megduplázódik.",
		"Elolvassam a hosszabb változatot is?",
	],
};

/** The person's own words are at most this many code points (spec §4.6). */
export const OWN_WORDS_MAX = 300;

const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * The words a person typed to hear, trimmed. Null when there are none, when
 * they are longer than `OWN_WORDS_MAX` code points, or when they hold no
 * letter or digit (then the sample plays instead).
 */
export function ownWords(text: string): string | null {
	const trimmed = text.trim();
	// A code point takes at most two UTF-16 units, so twice the limit in units
	// is over the limit in code points: a huge text is refused without a walk.
	if (trimmed.length === 0 || trimmed.length > OWN_WORDS_MAX * 2) return null;
	if (Array.from(trimmed).length > OWN_WORDS_MAX) return null;
	return SPEAKABLE.test(trimmed) ? trimmed : null;
}
