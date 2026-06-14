import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	getSystemSkillDefinition: vi.fn(),
	updateSystemSkillDefinition: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	getSystemSkillDefinition,
	updateSystemSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { GET, PATCH } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSystemSkillDefinition = getSystemSkillDefinition as ReturnType<
	typeof vi.fn
>;
const mockUpdateSystemSkillDefinition =
	updateSystemSkillDefinition as ReturnType<typeof vi.fn>;

function makeEvent(body?: unknown) {
	return {
		request: new Request(
			"http://localhost/api/admin/skills/system%3Ainterview",
			{
				method: body === undefined ? "GET" : "PATCH",
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		),
		locals: { user: { id: "admin-user", role: "admin" } },
		params: { id: "system:interview" },
		url: new URL("http://localhost/api/admin/skills/system%3Ainterview"),
		route: { id: "/api/admin/skills/[id]" },
	} as Parameters<typeof GET>[0] & Parameters<typeof PATCH>[0];
}

describe("/api/admin/skills/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
	});

	it("requires admin and rejects edits when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await PATCH(makeEvent({ published: true }));
		const data = await response.json();

		expect(mockRequireAdmin).toHaveBeenCalled();
		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockUpdateSystemSkillDefinition).not.toHaveBeenCalled();
	});

	it("reads and edits only through the System Skill service", async () => {
		mockGetSystemSkillDefinition.mockResolvedValue({
			id: "system:interview",
			ownership: "system",
			displayName: "Interview",
			instructions: "System instructions.",
			published: false,
		});
		mockUpdateSystemSkillDefinition.mockResolvedValue({
			id: "system:interview",
			ownership: "system",
			displayName: "Interview",
			instructions: "Updated system instructions.",
			enabled: true,
			published: true,
		});

		const getResponse = await GET(makeEvent());
		const getData = await getResponse.json();
		const patchResponse = await PATCH(
			makeEvent({
				userId: "victim-user",
				ownership: "user",
				instructions: "Updated system instructions.",
				enabled: true,
				published: true,
			}),
		);
		const patchData = await patchResponse.json();

		expect(getResponse.status).toBe(200);
		expect(getData.skill).toMatchObject({
			id: "system:interview",
			instructions: "System instructions.",
		});
		expect(mockGetSystemSkillDefinition).toHaveBeenCalledWith(
			"system:interview",
		);
		expect(patchResponse.status).toBe(200);
		expect(patchData.skill).toMatchObject({
			id: "system:interview",
			instructions: "Updated system instructions.",
			enabled: true,
			published: true,
		});
		expect(mockUpdateSystemSkillDefinition).toHaveBeenCalledWith(
			"system:interview",
			expect.objectContaining({
				instructions: "Updated system instructions.",
				enabled: true,
				published: true,
			}),
		);
	});

	it("returns 404 for missing System Skills", async () => {
		mockGetSystemSkillDefinition.mockResolvedValue(null);
		mockUpdateSystemSkillDefinition.mockResolvedValue(null);

		const getResponse = await GET(makeEvent());
		const patchResponse = await PATCH(makeEvent({ published: true }));

		expect(getResponse.status).toBe(404);
		expect(patchResponse.status).toBe(404);
	});
});
