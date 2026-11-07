import { beforeEach, describe, expect, it, vi } from "vitest";

const { getKnowledgeLibraryPageMock, isUserMemoryEnabledMock } = vi.hoisted(
	() => ({
		getKnowledgeLibraryPageMock: vi.fn(),
		isUserMemoryEnabledMock: vi.fn(),
	}),
);

vi.mock("$lib/server/services/knowledge", () => ({
	getKnowledgeLibraryPage: getKnowledgeLibraryPageMock,
}));

vi.mock("$lib/server/services/memory-controls", () => ({
	isUserMemoryEnabled: isUserMemoryEnabledMock,
}));

import { load } from "./+page.server";

function event(user: { id: string } | null = { id: "user-1" }) {
	return {
		locals: { user },
		url: new URL("http://localhost/knowledge"),
	} as unknown as Parameters<typeof load>[0];
}

describe("the Knowledge page's load", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getKnowledgeLibraryPageMock.mockResolvedValue({ documents: [] });
	});

	// The Memory tab says "Memory is off" in its first paint, so the page is
	// loaded knowing whether the person switched memory off in Settings.
	it.each([
		true,
		false,
	])("hands the page the person's memory switch (%s)", async (enabled) => {
		isUserMemoryEnabledMock.mockResolvedValue(enabled);

		const data = await load(event());

		expect(data).toMatchObject({
			memoryEnabled: enabled,
			library: { documents: [] },
		});
		expect(isUserMemoryEnabledMock).toHaveBeenCalledWith("user-1");
	});

	it("sends a signed-out visitor to the login page", async () => {
		await expect(load(event(null))).rejects.toMatchObject({
			status: 302,
			location: "/login",
		});
	});
});
