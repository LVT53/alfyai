import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchTerms } from "$lib/shared/workspace-search-text";

// What a memory result is, and where it opens. Which entries are found, and
// which are never, is native-read.test.ts's on a real database.
const { mockSearchMemoryEntries } = vi.hoisted(() => ({
	mockSearchMemoryEntries: vi.fn(),
}));

vi.mock("$lib/server/services/memory-profile/native-read", () => ({
	searchMemoryEntries: mockSearchMemoryEntries,
}));

const { searchMemories } = await import("./memories");

beforeEach(() => {
	mockSearchMemoryEntries.mockReset();
});

describe("searchMemories", () => {
	it("links each entry to its place in Memory", async () => {
		mockSearchMemoryEntries.mockReturnValue({
			entries: [
				{
					ref: {
						scope: { kind: "personal" },
						generation: "g1",
						rowId: "row-1",
					},
					text: "Writing a thesis on timber housing",
					projectName: null,
					lastSaidAt: "2026-11-01T00:00:00.000Z",
				},
				{
					ref: {
						scope: { kind: "project", projectId: "p 1/x" },
						generation: "g1",
						rowId: "row 2&3",
					},
					text: "The thesis model is built at 1:50 scale",
					projectName: "Thesis project",
					lastSaidAt: null,
				},
			],
			total: 2,
			hasMore: false,
			searchable: true,
		});

		const found = await searchMemories(
			"user-1",
			searchTerms("thesis model"),
			"  thesis  model ",
			{ offset: 0, limit: 3 },
		);

		expect(found.results).toEqual([
			{
				id: "row-1",
				scope: { kind: "personal" },
				projectName: null,
				text: "Writing a thesis on timber housing",
				lastSaidAt: "2026-11-01T00:00:00.000Z",
				href: "/knowledge?tab=memory&memoryScope=personal&memoryEntry=row-1&memoryQuery=thesis%20model",
			},
			{
				id: "row 2&3",
				scope: { kind: "project", projectId: "p 1/x" },
				projectName: "Thesis project",
				text: "The thesis model is built at 1:50 scale",
				lastSaidAt: null,
				href: "/knowledge?tab=memory&memoryScope=project%3Ap%201%2Fx&memoryEntry=row%202%263&memoryQuery=thesis%20model",
			},
		]);
		expect(found).toMatchObject({ total: 2, hasMore: false, searchable: true });
		expect(mockSearchMemoryEntries).toHaveBeenCalledWith(
			"user-1",
			["thesis", "model"],
			{ offset: 0, limit: 3, countCap: 100 },
		);
	});

	it("carries the cleaned words in the link, short enough for Memory's own search", async () => {
		mockSearchMemoryEntries.mockReturnValue({
			entries: [
				{
					ref: {
						scope: { kind: "personal" },
						generation: "g1",
						rowId: "row-1",
					},
					text: "Writing a thesis",
					projectName: null,
					lastSaidAt: null,
				},
			],
			total: 1,
			hasMore: false,
			searchable: true,
		});
		const memoryQueryOf = async (query: string) => {
			const found = await searchMemories("user-1", searchTerms(query), query, {
				offset: 0,
				limit: 3,
			});
			return (
				new URL(found.results[0].href, "http://localhost").searchParams.get(
					"memoryQuery",
				) ?? ""
			);
		};
		expect(await memoryQueryOf(`"Thesis," model!!  ${"z".repeat(600)}`)).toBe(
			`thesis model ${"z".repeat(64)}`,
		);
		// Eight words of 64 letters are 519 characters; Memory takes 500.
		const longest = await memoryQueryOf(
			Array.from({ length: 8 }, (_, index) =>
				String.fromCharCode(97 + index).repeat(70),
			).join(" "),
		);
		expect(longest.length).toBeLessThanOrEqual(500);
		expect(longest.startsWith("a".repeat(64))).toBe(true);
	});

	it("passes a query with no words on to find out whether Memory is searchable", async () => {
		mockSearchMemoryEntries.mockReturnValue({
			entries: [],
			total: 0,
			hasMore: false,
			searchable: true,
		});
		const found = await searchMemories("user-1", [], "!!", {
			offset: 0,
			limit: 3,
		});
		expect(found).toEqual({
			results: [],
			total: 0,
			hasMore: false,
			searchable: true,
		});
	});
});
