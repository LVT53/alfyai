import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	createUserSkillDefinition: vi.fn(),
	listEnabledSystemSkillSummaries: vi.fn(),
	listUserSkillDefinitions: vi.fn(),
}));

import { getConfig } from "$lib/server/config-store";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	createUserSkillDefinition,
	listEnabledSystemSkillSummaries,
	listUserSkillDefinitions,
} from "$lib/server/services/skills/user-skills";
import { GET, POST } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateUserSkillDefinition = createUserSkillDefinition as ReturnType<typeof vi.fn>;
const mockListEnabledSystemSkillSummaries = listEnabledSystemSkillSummaries as ReturnType<
	typeof vi.fn
>;
const mockListUserSkillDefinitions = listUserSkillDefinitions as ReturnType<typeof vi.fn>;

function makeEvent(body?: unknown) {
	return {
		request: new Request("http://localhost/api/skills", {
			method: body === undefined ? "GET" : "POST",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "owner-user", role: "user" } },
		params: {},
		url: new URL("http://localhost/api/skills"),
		route: { id: "/api/skills" },
	} as Parameters<typeof GET>[0] & Parameters<typeof POST>[0];
}

describe("/api/skills", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
	});

	it("rejects list access when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockListUserSkillDefinitions).not.toHaveBeenCalled();
	});

	it("rejects create access when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await POST(
			makeEvent({ displayName: "Draft", instructions: "Review this." }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockCreateUserSkillDefinition).not.toHaveBeenCalled();
	});

	it("lists only the authenticated user's skills", async () => {
		mockListUserSkillDefinitions.mockResolvedValue([{ id: "skill-1", displayName: "Skill" }]);
		mockListEnabledSystemSkillSummaries.mockResolvedValue([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				description: "A safe summary.",
				instructions: "LEAKED_SYSTEM_INSTRUCTIONS",
				localizedDefaults: {
					en: {
						displayName: "Interview",
						description: "A safe summary.",
						instructions: "LEAKED_EN_INSTRUCTIONS",
					},
					hu: {
						displayName: "Interjú",
						description: "Biztonságos összefoglaló.",
						instructions: "LEAKED_HU_INSTRUCTIONS",
					},
				},
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.skills).toEqual([{ id: "skill-1", displayName: "Skill" }]);
		expect(data.systemSkills).toEqual([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				description: "A safe summary.",
				localizedDefaults: {
					en: {
						displayName: "Interview",
						description: "A safe summary.",
					},
					hu: {
						displayName: "Interjú",
						description: "Biztonságos összefoglaló.",
					},
				},
			},
		]);
		const serializedSystemSkills = JSON.stringify(data.systemSkills);
		expect(serializedSystemSkills).not.toContain("instructions");
		expect(serializedSystemSkills).not.toContain("LEAKED_SYSTEM_INSTRUCTIONS");
		expect(serializedSystemSkills).not.toContain("LEAKED_EN_INSTRUCTIONS");
		expect(serializedSystemSkills).not.toContain("LEAKED_HU_INSTRUCTIONS");
		expect(mockListUserSkillDefinitions).toHaveBeenCalledWith("owner-user");
		expect(mockListEnabledSystemSkillSummaries).toHaveBeenCalledWith();
	});

	it("creates a skill for the authenticated user and ignores body user ids", async () => {
		mockCreateUserSkillDefinition.mockResolvedValue({
			id: "skill-1",
			displayName: "Meeting critic",
		});

		const response = await POST(
			makeEvent({
				userId: "attacker-user",
				displayName: "Meeting critic",
				instructions: "Review meeting notes.",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.skill).toEqual({ id: "skill-1", displayName: "Meeting critic" });
		expect(mockCreateUserSkillDefinition).toHaveBeenCalledWith(
			"owner-user",
			expect.objectContaining({
				displayName: "Meeting critic",
				instructions: "Review meeting notes.",
			}),
		);
	});
});
