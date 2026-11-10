import { describe, expect, it } from "vitest";
import {
	ALLOWED_ACTION_DESTINATIONS,
	isAllowedActionDestination,
} from "./campaign-action-destinations";

describe("campaign action destinations", () => {
	it("keeps the campaign allow-list exactly as published campaigns know it", () => {
		expect(ALLOWED_ACTION_DESTINATIONS).toEqual([
			"/",
			"/chat",
			"/knowledge",
			"/settings",
			"/settings/profile",
			"/settings/admin",
			"internal:chatgpt-import",
		]);
	});

	it("never offers a guide-only place to a campaign", () => {
		expect(isAllowedActionDestination("/guide")).toBe(false);
	});
});
