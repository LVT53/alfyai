import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/memory-profile/projection-store", () => ({
	createMemoryProfileItem: vi.fn(),
	mergeMemoryProfileItemMetadata: vi.fn(),
	addMemoryProfileItemProvenance: vi.fn(),
}));

import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	mergeMemoryProfileItemMetadata,
} from "$lib/server/services/memory-profile/projection-store";
import { POST } from "./+server";

const mockCreate = vi.mocked(createMemoryProfileItem);
const mockMergeMetadata = vi.mocked(mergeMemoryProfileItemMetadata);
const mockAddProvenance = vi.mocked(addMemoryProfileItemProvenance);

function makeEvent(
	body: unknown,
	user: { id: string } | null = { id: "user-1" },
) {
	return {
		locals: { user: user ? { ...user, role: "user" } : null },
		params: {},
		request: new Request("http://localhost/api/memory/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		url: new URL("http://localhost/api/memory/notes"),
		route: { id: "/api/memory/notes" },
	} as Parameters<typeof POST>[0];
}

describe("POST /api/memory/notes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue({
			id: "item-1",
			itemKey: "key-1",
			status: "active",
			revision: 0,
			resetGeneration: 0,
			projectionRevision: 1,
		});
		mockMergeMetadata.mockResolvedValue(undefined);
		mockAddProvenance.mockResolvedValue({
			id: "provenance-1",
			sourceType: "composer_command",
			label: "/remember command",
			summary: null,
		});
	});

	it("saves a note as a user-authored active memory profile item", async () => {
		const response = await POST(makeEvent({ text: "I prefer dark mode." }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ id: "item-1", statement: "I prefer dark mode." });
		expect(mockCreate).toHaveBeenCalledWith({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "I prefer dark mode.",
			status: "active",
		});
		expect(mockMergeMetadata).toHaveBeenCalledWith({
			userId: "user-1",
			itemId: "item-1",
			patch: { origin: "user_authored" },
		});
		expect(mockAddProvenance).toHaveBeenCalledWith({
			userId: "user-1",
			itemId: "item-1",
			sourceType: "composer_command",
			label: "/remember command",
		});
	});

	it("trims whitespace before persisting", async () => {
		await POST(makeEvent({ text: "  Loves oat milk.  " }));

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ statement: "Loves oat milk." }),
		);
	});

	it("rejects an empty note", async () => {
		const response = await POST(makeEvent({ text: "   " }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("text is required");
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("rejects a note over the 2,000-character cap", async () => {
		const response = await POST(makeEvent({ text: "a".repeat(2001) }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("2000 characters or fewer");
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("rejects a missing text field", async () => {
		const response = await POST(makeEvent({}));

		expect(response.status).toBe(400);
		expect(mockCreate).not.toHaveBeenCalled();
	});
});
