import { describe, expect, it } from "vitest";
import { shouldPersistCampaignCompletion } from "./campaign-replay";

describe("campaign replay mode", () => {
	it("persists terminal state only for automatic campaign display", () => {
		expect(shouldPersistCampaignCompletion("auto")).toBe(true);
		expect(shouldPersistCampaignCompletion("replay")).toBe(false);
	});
});
