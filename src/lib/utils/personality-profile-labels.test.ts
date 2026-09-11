import { describe, expect, it } from "vitest";
import {
	getPersonalityProfileDisplayDescription,
	getPersonalityProfileDisplayName,
} from "./personality-profile-labels";

const translate = (key: string) => `t:${key}`;

describe("personality profile labels", () => {
	it("maps every built-in style, old name or new, to its translated label", () => {
		const cases: Array<[string, string]> = [
			["Default", "personalityProfile.default.name"],
			["Brief", "personalityProfile.brief.name"],
			["Concise", "personalityProfile.brief.name"],
			["Thinking partner", "personalityProfile.thinkingPartner.name"],
			["Exploratory", "personalityProfile.thinkingPartner.name"],
			["Storyteller", "personalityProfile.storyteller.name"],
			["Creative", "personalityProfile.storyteller.name"],
			["Technical", "personalityProfile.technical.name"],
			["Warm", "personalityProfile.warm.name"],
		];
		for (const [name, key] of cases) {
			expect(
				getPersonalityProfileDisplayName({ name, isBuiltIn: true }, translate),
				name,
			).toBe(`t:${key}`);
		}
	});

	it("leaves a user-made style's own words alone, even under a built-in name", () => {
		const profile = {
			name: "Warm",
			description: "My own warm style",
			isBuiltIn: false,
		};
		expect(getPersonalityProfileDisplayName(profile, translate)).toBe("Warm");
		expect(getPersonalityProfileDisplayDescription(profile, translate)).toBe(
			"My own warm style",
		);
	});
});
