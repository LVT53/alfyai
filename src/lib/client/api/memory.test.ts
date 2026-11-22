import { describe, expect, it, vi } from "vitest";
import {
	fetchMemoryDetail,
	fetchMemoryPage,
	submitMemoryAction,
} from "./memory";

const scope = { kind: "personal" } as const;
describe("Memory transport", () => {
	it("keeps scope, query and cursor separate and validates list results", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				authority: "hindsight",
				scope,
				generation: "g1",
				rows: [],
				nextCursor: null,
				status: "ready",
				total: 0,
			}),
		);
		await fetchMemoryPage(
			{
				scope: { kind: "project", projectId: "p/1" },
				query: "tea & coffee",
				cursor: "next+1",
			},
			undefined,
			fetcher,
		);
		const url = new URL(fetcher.mock.calls[0][0], "http://localhost");
		expect(url.searchParams.get("projectId")).toBe("p/1");
		expect(url.searchParams.get("query")).toBe("tea & coffee");
		expect(url.searchParams.get("cursor")).toBe("next+1");
	});
	it("rejects a legacy profile response rather than showing an empty complete list", async () => {
		await expect(
			fetchMemoryPage({ scope }, undefined, async () =>
				Response.json({ items: [] }),
			),
		).rejects.toThrow();
	});
	it("accepts a null date on list and detail rows", async () => {
		const ref = { scope, generation: "g1", rowId: "r1" };
		const row = { ref, text: "Tea", updatedAt: null, sourceCount: 0 };
		const fetchPage = async () =>
			Response.json({
				authority: "hindsight",
				scope,
				generation: ref.generation,
				rows: [row],
				nextCursor: null,
				status: "ready",
				total: 1,
			});
		const fetchDetail = async () =>
			Response.json({
				row,
				sources: [],
				versions: [],
				canEdit: true,
				canRemove: true,
			});
		await expect(
			fetchMemoryPage({ scope }, undefined, fetchPage),
		).resolves.toMatchObject({
			rows: [row],
		});
		await expect(
			fetchMemoryDetail(ref, undefined, fetchDetail),
		).resolves.toMatchObject({ row });
	});
	it("requires snapshot identity for details", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				row: {
					ref: { scope, generation: "g1", rowId: "r/1" },
					text: "Tea",
					updatedAt: "2026-11-18",
					sourceCount: 0,
				},
				sources: [],
				versions: [],
				canEdit: true,
				canRemove: true,
			}),
		);
		await fetchMemoryDetail(
			{ scope, generation: "g1", rowId: "r/1" },
			undefined,
			fetcher,
		);
		expect(fetcher.mock.calls[0][0]).toContain("r%2F1?");
		expect(fetcher.mock.calls[0][0]).toContain("generation=g1");
	});
	it("preserves idempotency keys and does not mistake queued for saved", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				id: "op",
				status: "queued",
				retryable: false,
				errorCode: null,
				exclusionAcknowledged: false,
				cleanupPending: false,
				ref: null,
			}),
		);
		const action = {
			kind: "add",
			scope,
			text: "Tea",
			requestId: "request-1",
		} as const;
		const result = await submitMemoryAction(action, undefined, fetcher);
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(action);
		expect(result.status).toBe("queued");
	});
});
