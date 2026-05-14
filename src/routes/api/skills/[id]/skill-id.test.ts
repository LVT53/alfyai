import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	deleteUserSkillDefinition: vi.fn(),
	getUserSkillDefinition: vi.fn(),
	updateUserSkillDefinition: vi.fn(),
}));

import { getConfig } from "$lib/server/config-store";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteUserSkillDefinition,
	getUserSkillDefinition,
	updateUserSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { DELETE, GET, PATCH } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDeleteUserSkillDefinition = deleteUserSkillDefinition as ReturnType<typeof vi.fn>;
const mockGetUserSkillDefinition = getUserSkillDefinition as ReturnType<typeof vi.fn>;
const mockUpdateUserSkillDefinition = updateUserSkillDefinition as ReturnType<typeof vi.fn>;

function makeEvent(body?: unknown) {
	return {
		request: new Request("http://localhost/api/skills/skill-1", {
			method: body === undefined ? "GET" : "PATCH",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "owner-user", role: "user" } },
		params: { id: "skill-1" },
		url: new URL("http://localhost/api/skills/skill-1"),
		route: { id: "/api/skills/[id]" },
	} as Parameters<typeof GET>[0] & Parameters<typeof PATCH>[0] & Parameters<typeof DELETE>[0];
}

describe("/api/skills/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
	});

	it("rejects updates when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await PATCH(makeEvent({ displayName: "Updated" }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockUpdateUserSkillDefinition).not.toHaveBeenCalled();
	});

	it("rejects deletes when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockDeleteUserSkillDefinition).not.toHaveBeenCalled();
	});

	it("reads and updates only through the authenticated owner", async () => {
		mockGetUserSkillDefinition.mockResolvedValue({ id: "skill-1", displayName: "Skill" });
		mockUpdateUserSkillDefinition.mockResolvedValue({
			id: "skill-1",
			displayName: "Updated skill",
			enabled: false,
		});

		const getResponse = await GET(makeEvent());
		const getData = await getResponse.json();
		const patchResponse = await PATCH(makeEvent({ userId: "attacker-user", enabled: false }));
		const patchData = await patchResponse.json();

		expect(getResponse.status).toBe(200);
		expect(getData.skill).toEqual({ id: "skill-1", displayName: "Skill" });
		expect(mockGetUserSkillDefinition).toHaveBeenCalledWith("owner-user", "skill-1");
		expect(patchResponse.status).toBe(200);
		expect(patchData.skill).toEqual({
			id: "skill-1",
			displayName: "Updated skill",
			enabled: false,
		});
		expect(mockUpdateUserSkillDefinition).toHaveBeenCalledWith(
			"owner-user",
			"skill-1",
			expect.objectContaining({ enabled: false }),
		);
	});

	it("returns 404 for missing owner-scoped skills and deletes by owner", async () => {
		mockGetUserSkillDefinition.mockResolvedValue(null);
		mockDeleteUserSkillDefinition.mockResolvedValue(true);

		const getResponse = await GET(makeEvent());
		const deleteResponse = await DELETE(makeEvent());
		const deleteData = await deleteResponse.json();

		expect(getResponse.status).toBe(404);
		expect(deleteResponse.status).toBe(200);
		expect(deleteData.success).toBe(true);
		expect(mockDeleteUserSkillDefinition).toHaveBeenCalledWith("owner-user", "skill-1");
	});
});
