import type { I18nKey } from "$lib/i18n";

type Translate = (key: I18nKey) => string;

export type PersonalityProfileLabelSource = {
	name: string;
	description?: string | null;
	isBuiltIn?: boolean | number | null;
};

const BUILT_IN_PROFILE_KEYS = {
	Default: {
		name: "personalityProfile.default.name",
		description: "personalityProfile.default.description",
	},
	Brief: {
		name: "personalityProfile.brief.name",
		description: "personalityProfile.brief.description",
	},
	"Thinking partner": {
		name: "personalityProfile.thinkingPartner.name",
		description: "personalityProfile.thinkingPartner.description",
	},
	Storyteller: {
		name: "personalityProfile.storyteller.name",
		description: "personalityProfile.storyteller.description",
	},
	Technical: {
		name: "personalityProfile.technical.name",
		description: "personalityProfile.technical.description",
	},
	Warm: {
		name: "personalityProfile.warm.name",
		description: "personalityProfile.warm.description",
	},
	// The names the three renamed built-ins carried until 2026-09-11. A list
	// read before the seed has run still shows the new words.
	Concise: {
		name: "personalityProfile.brief.name",
		description: "personalityProfile.brief.description",
	},
	Exploratory: {
		name: "personalityProfile.thinkingPartner.name",
		description: "personalityProfile.thinkingPartner.description",
	},
	Creative: {
		name: "personalityProfile.storyteller.name",
		description: "personalityProfile.storyteller.description",
	},
} as const satisfies Record<string, { name: I18nKey; description: I18nKey }>;

function builtInKeysFor(profile: PersonalityProfileLabelSource) {
	if (profile.isBuiltIn === false || profile.isBuiltIn === 0) return null;
	return (
		BUILT_IN_PROFILE_KEYS[profile.name as keyof typeof BUILT_IN_PROFILE_KEYS] ??
		null
	);
}

export function getPersonalityProfileDisplayName(
	profile: PersonalityProfileLabelSource,
	translate: Translate,
): string {
	const keys = builtInKeysFor(profile);
	return keys ? translate(keys.name) : profile.name;
}

export function getPersonalityProfileDisplayDescription(
	profile: PersonalityProfileLabelSource,
	translate: Translate,
): string {
	const keys = builtInKeysFor(profile);
	return keys ? translate(keys.description) : (profile.description ?? "");
}
