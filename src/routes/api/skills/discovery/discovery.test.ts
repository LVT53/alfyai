import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	discoverSkillSummaries: vi.fn(),
	localizeSkillDiscoverySummary: vi.fn((skill) => skill),
	seedBuiltInSystemSkillDefinitions: vi.fn(),
}));

import { getConfig } from "$lib/server/config-store";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	discoverSkillSummaries,
	seedBuiltInSystemSkillDefinitions,
} from "$lib/server/services/skills/user-skills";
import { GET } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDiscoverSkillSummaries = discoverSkillSummaries as ReturnType<typeof vi.fn>;
const mockSeedBuiltInSystemSkillDefinitions = seedBuiltInSystemSkillDefinitions as ReturnType<
	typeof vi.fn
>;

function makeEvent(url = "http://localhost/api/skills/discovery?q=interview") {
	return {
		request: new Request(url),
		locals: { user: { id: "owner-user", role: "user", uiLanguage: "en" } },
		params: {},
		url: new URL(url),
		route: { id: "/api/skills/discovery" },
	} as Parameters<typeof GET>[0];
}

describe("/api/skills/discovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mockDiscoverSkillSummaries.mockResolvedValue([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interviews.",
				activationExamples: ["practice"],
				enabled: true,
			},
		]);
	});

	it("returns authenticated skill discovery summaries without instruction bodies", async () => {
		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.skills).toEqual([
			expect.objectContaining({
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
			}),
		]);
		expect(JSON.stringify(data.skills)).not.toContain("instructions");
		expect(mockSeedBuiltInSystemSkillDefinitions).toHaveBeenCalledWith("owner-user");
		expect(mockDiscoverSkillSummaries).toHaveBeenCalledWith("owner-user", "interview");
	});

	it("rejects discovery when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await GET(makeEvent("http://localhost/api/skills/discovery"));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockSeedBuiltInSystemSkillDefinitions).not.toHaveBeenCalled();
		expect(mockDiscoverSkillSummaries).not.toHaveBeenCalled();
	});
});
