import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	createSystemSkillDefinition: vi.fn(),
	listAdminSystemSkillDefinitions: vi.fn(),
	seedBuiltInSystemSkillDefinitions: vi.fn(),
}));

import { getConfig } from "$lib/server/config-store";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createSystemSkillDefinition,
	listAdminSystemSkillDefinitions,
	seedBuiltInSystemSkillDefinitions,
} from "$lib/server/services/skills/user-skills";
import { GET, POST } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCreateSystemSkillDefinition = createSystemSkillDefinition as ReturnType<typeof vi.fn>;
const mockListAdminSystemSkillDefinitions = listAdminSystemSkillDefinitions as ReturnType<
	typeof vi.fn
>;
const mockSeedBuiltInSystemSkillDefinitions = seedBuiltInSystemSkillDefinitions as ReturnType<
	typeof vi.fn
>;

function makeEvent(body?: unknown) {
	return {
		request: new Request("http://localhost/api/admin/skills", {
			method: body === undefined ? "GET" : "POST",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "admin-user", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/skills"),
		route: { id: "/api/admin/skills" },
	} as Parameters<typeof GET>[0] & Parameters<typeof POST>[0];
}

describe("/api/admin/skills", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
	});

	it("requires admin and rejects access when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(mockRequireAdmin).toHaveBeenCalled();
		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockSeedBuiltInSystemSkillDefinitions).not.toHaveBeenCalled();
		expect(mockListAdminSystemSkillDefinitions).not.toHaveBeenCalled();
	});

	it("seeds built-ins and lists only System Skills for admin management", async () => {
		mockListAdminSystemSkillDefinitions.mockResolvedValue([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				instructions: "System body is allowed here.",
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockSeedBuiltInSystemSkillDefinitions).toHaveBeenCalledWith("admin-user");
		expect(data.skills).toEqual([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				instructions: "System body is allowed here.",
			},
		]);
	});

	it("creates System Skills for the admin boundary and ignores body ownership/user ids", async () => {
		mockCreateSystemSkillDefinition.mockResolvedValue({
			id: "system-custom",
			ownership: "system",
			displayName: "Custom",
			published: false,
		});

		const response = await POST(
			makeEvent({
				userId: "victim-user",
				ownership: "user",
				displayName: "Custom",
				instructions: "System-only instructions.",
				published: true,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.skill).toEqual({
			id: "system-custom",
			ownership: "system",
			displayName: "Custom",
			published: false,
		});
		expect(mockCreateSystemSkillDefinition).toHaveBeenCalledWith(
			"admin-user",
			expect.objectContaining({
				displayName: "Custom",
				instructions: "System-only instructions.",
				published: true,
			}),
		);
	});
});
