import { describe, expect, it } from "vitest";
import {
	APP_PLACES,
	appPlacePath,
	CAMPAIGN_ACTION_PATHS,
	SPOTLIGHT_IDS,
} from "./app-places";

describe("app places", () => {
	it("gives every place one same-origin path", () => {
		for (const { path } of Object.values(APP_PLACES)) {
			expect(path.startsWith("/") && !path.startsWith("//")).toBe(true);
		}
	});

	it("derives the campaign paths from the places marked for campaigns", () => {
		expect(CAMPAIGN_ACTION_PATHS).toEqual([
			"/",
			"/chat",
			"/knowledge",
			"/settings",
			"/settings/profile",
			"/settings/admin",
		]);
	});

	it("gives the path of a place by its id", () => {
		expect(appPlacePath("home")).toBe("/");
		expect(appPlacePath("knowledgeMemory")).toBe("/knowledge?tab=memory");
		expect(appPlacePath("guide")).toBe("/guide");
	});

	it("names eighteen distinct spotlight ids as area.control", () => {
		expect(new Set(SPOTLIGHT_IDS).size).toBe(18);
		for (const id of SPOTLIGHT_IDS) {
			expect(id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
		}
	});
});
