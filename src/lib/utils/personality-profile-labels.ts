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
	Concise: {
		name: "personalityProfile.concise.name",
		description: "personalityProfile.concise.description",
	},
	Exploratory: {
		name: "personalityProfile.exploratory.name",
		description: "personalityProfile.exploratory.description",
	},
	Creative: {
		name: "personalityProfile.creative.name",
		description: "personalityProfile.creative.description",
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
