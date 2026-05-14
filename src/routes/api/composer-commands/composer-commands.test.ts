import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

import { getConfig } from "$lib/server/config-store";
import { GET } from "./+server";

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;

function makeEvent() {
	return {
		locals: { user: { id: "user-1", role: "user" } },
		params: {},
		url: new URL("http://localhost/api/composer-commands"),
		route: { id: "/api/composer-commands" },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/composer-commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects registry access when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Composer Command Registry is disabled.");
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
	});

	it("returns the static Normal Chat slash command catalog when enabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.registry.scope).toBe("normal_chat");
		expect(data.registry.commands.map((command: { token: string }) => command.token)).toEqual([
			"/model",
			"/style",
			"/thinking",
			"/attach",
			"/document",
			"/source",
			"/skill",
			"/settings",
			"/clear",
			"/research",
		]);
	});
});
