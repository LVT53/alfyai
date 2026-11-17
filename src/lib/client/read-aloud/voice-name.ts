/**
 * The name the voice editor suggests for a new voice (spec §4.6; the prototype's
 * `syncName`), from what `nameParts` says changed: a style's name, the two
 * biggest changes, one change, or "My {voice}". The words are the knobs' own,
 * lower-cased in the UI language, so "Imogen, very calm and slower" and
 * "Imogen, nagyon nyugodt és lassabb".
 */

import {
	clipVoiceName,
	type Knobs,
	nameParts,
	VOICE_NAME_MAX,
} from "$lib/shared/read-aloud/voice-knobs";

type Translate = (key: string, values?: Record<string, string>) => string;

export function suggestVoiceName(input: {
	voiceName: string;
	knobs: Knobs;
	t: Translate;
	locale: "en" | "hu";
}): string {
	const { voiceName: voice, t, locale } = input;
	const parts = nameParts(input.knobs);
	if (parts.kind === "style")
		return clipVoiceName(
			t("readAloud.editor.nameStyle", {
				style: t(`readAloud.style.${parts.style}`),
				voice,
			}),
		);
	if (parts.kind === "mine")
		return clipVoiceName(t("readAloud.editor.nameMine", { voice }));
	const [first, second] = parts.changes.map((change) =>
		t(`readAloud.knob.${change.key}.${change.word}`).toLocaleLowerCase(locale),
	);
	if (first === undefined)
		return clipVoiceName(t("readAloud.editor.nameMine", { voice }));
	if (second !== undefined) {
		const two = t("readAloud.editor.nameTwo", { voice, first, second });
		if ([...two].length <= VOICE_NAME_MAX) return two;
	}
	return clipVoiceName(t("readAloud.editor.nameOne", { voice, first }));
}
