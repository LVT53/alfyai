import { describe, expect, it, vi } from "vitest";
import {
	fetchMemoryDetail,
	fetchMemoryPage,
	fetchMemorySubject,
	fetchMemorySubjectIndex,
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

describe("the subject index's transport", () => {
	const index = {
		authority: "hindsight",
		scope,
		generation: "g1",
		status: "ready",
		subjects: [
			{
				subject: "projects",
				count: 2,
				preview: "Building a garden shed.",
				active: true,
				earlierCount: 1,
				earlierPreview: ["A trip that ended"],
			},
		],
		earlier: { count: 1, preview: ["A trip that ended"] },
		currentCount: 2,
	};
	const entry = {
		ref: { scope, generation: "g1", rowId: "r1" },
		text: "Building a garden shed.",
		subject: "projects",
		kind: "ongoing",
		timeState: "quiet",
		lastMentionedAt: "2026-10-25T12:00:00.000Z",
		quietWeeks: 4,
		earlierStates: [{ text: "Planned a shed", saidAt: null }],
	};

	it("reads the index for a scope and validates it", async () => {
		const fetcher = vi.fn().mockResolvedValue(Response.json(index));
		await expect(
			fetchMemorySubjectIndex(
				{ kind: "project", projectId: "p/1" },
				undefined,
				fetcher,
			),
		).resolves.toEqual(index);
		const url = new URL(fetcher.mock.calls[0][0], "http://localhost");
		expect(url.pathname).toBe("/api/knowledge/memory/subjects");
		expect(url.searchParams.get("projectId")).toBe("p/1");
	});

	it("rejects an index without its subjects", async () => {
		await expect(
			fetchMemorySubjectIndex(scope, undefined, async () =>
				Response.json({ ...index, subjects: undefined }),
			),
		).rejects.toThrow();
	});

	it("reads one subject's Earlier entries with its cursor", async () => {
		const page = {
			scope,
			generation: "g1",
			subject: "all",
			state: "earlier",
			entries: [entry],
			total: 1,
			nextCursor: null,
		};
		const fetcher = vi.fn().mockResolvedValue(Response.json(page));
		await expect(
			fetchMemorySubject(
				{ scope, subject: "all", state: "earlier", cursor: "c+1" },
				undefined,
				fetcher,
			),
		).resolves.toEqual(page);
		const url = new URL(fetcher.mock.calls[0][0], "http://localhost");
		expect(url.pathname).toBe("/api/knowledge/memory/subjects/all");
		expect(url.searchParams.get("state")).toBe("earlier");
		expect(url.searchParams.get("cursor")).toBe("c+1");
	});

	it("rejects an entry whose time state it does not know", async () => {
		await expect(
			fetchMemorySubject(
				{ scope, subject: "projects", state: "current" },
				undefined,
				async () =>
					Response.json({
						scope,
						generation: "g1",
						subject: "projects",
						state: "current",
						entries: [{ ...entry, timeState: "stale" }],
						total: 1,
						nextCursor: null,
					}),
			),
		).rejects.toThrow();
	});
});
