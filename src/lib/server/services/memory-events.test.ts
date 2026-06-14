import { beforeEach, describe, expect, it, vi } from "vitest";

type MemoryEventRow = {
	id: string;
	eventKey: string;
	userId: string;
	conversationId: string | null;
	messageId: string | null;
	domain: string;
	eventType: string;
	subjectId: string | null;
	relatedId: string | null;
	observedAt: Date;
	payloadJson: string | null;
	createdAt: Date;
};

const { rows } = vi.hoisted(() => ({
	rows: [] as MemoryEventRow[],
}));

vi.mock("$lib/server/db", () => ({
	db: {
		insert: () => ({
			values: (values: MemoryEventRow | MemoryEventRow[]) => ({
				onConflictDoNothing: vi.fn(async () => {
					const items = Array.isArray(values) ? values : [values];
					for (const item of items) {
						if (rows.some((row) => row.eventKey === item.eventKey)) continue;
						rows.push({
							...item,
							createdAt: item.createdAt ?? new Date(),
						});
					}
				}),
			}),
		}),
		select: () => ({
			from: () => ({
				where: (
					conditions: Array<{ field: string; value: string | string[] }>,
				) => ({
					orderBy: () => ({
						limit: async (count: number) =>
							rows
								.slice()
								.filter((row) =>
									conditions.every((condition) => {
										const rowValue =
											row[condition.field as keyof MemoryEventRow];
										if (Array.isArray(condition.value)) {
											return condition.value.includes(String(rowValue));
										}
										return String(rowValue) === String(condition.value);
									}),
								)
								.sort(
									(left, right) =>
										right.observedAt.getTime() - left.observedAt.getTime(),
								)
								.slice(0, count),
					}),
				}),
			}),
		}),
		delete: (_table: unknown) => ({
			where: async (
				condition:
					| { field: string; value: string | string[] }
					| Array<{ field: string; value: string | string[] }>,
			) => {
				const conds = Array.isArray(condition) ? condition : [condition];
				for (const cond of conds) {
					if (cond.field === "id" && Array.isArray(cond.value)) {
						const idSet = new Set(cond.value as string[]);
						for (let i = rows.length - 1; i >= 0; i--) {
							if (idSet.has(rows[i].id)) {
								rows.splice(i, 1);
							}
						}
					}
				}
			},
		}),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	memoryEvents: {
		id: { name: "id" },
		eventKey: { name: "eventKey" },
		userId: { name: "userId" },
		domain: { name: "domain" },
		eventType: { name: "eventType" },
		subjectId: { name: "subjectId" },
		observedAt: { name: "observedAt" },
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	desc: vi.fn(() => "desc"),
	eq: vi.fn((field: { name: string }, value: string) => ({
		field: field.name,
		value,
	})),
	inArray: vi.fn((field: { name: string }, value: string[]) => ({
		field: field.name,
		value,
	})),
}));

vi.mock("$lib/server/utils/json", () => ({
	parseJsonRecord: vi.fn((value: string | null) =>
		value ? JSON.parse(value) : null,
	),
}));

describe("memory-events service", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
	});

	it("persists deduplicated events by event key", async () => {
		const { recordMemoryEvent, listMemoryEvents } = await import(
			"./memory-events"
		);

		await recordMemoryEvent({
			eventKey: "deadline_set:cluster-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "cluster-1",
			payload: { topicKey: "assessment" },
		});
		await recordMemoryEvent({
			eventKey: "deadline_set:cluster-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "cluster-1",
			payload: { topicKey: "assessment" },
		});

		const events = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventKey: "deadline_set:cluster-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "cluster-1",
			payload: { topicKey: "assessment" },
		});
	});

	it("deduplicates event keys per user instead of globally", async () => {
		const { recordMemoryEvent, listMemoryEvents } = await import(
			"./memory-events"
		);

		await recordMemoryEvent({
			eventKey: "deadline_set:cluster-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "cluster-1",
		});
		await recordMemoryEvent({
			eventKey: "deadline_set:cluster-1",
			userId: "user-2",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "cluster-1",
		});

		const userOneEvents = await listMemoryEvents({
			userId: "user-1",
			limit: 10,
		});
		const userTwoEvents = await listMemoryEvents({
			userId: "user-2",
			limit: 10,
		});

		expect(userOneEvents).toHaveLength(1);
		expect(userTwoEvents).toHaveLength(1);
		expect(userOneEvents[0]?.eventKey).toBe("deadline_set:cluster-1");
		expect(userTwoEvents[0]?.eventKey).toBe("deadline_set:cluster-1");
	});

	it("counts recent events by subject within the requested window", async () => {
		const { recordMemoryEvent, countRecentMemoryEventsBySubject } =
			await import("./memory-events");

		await recordMemoryEvent({
			eventKey: "document_refined:family-brief:1",
			userId: "user-1",
			domain: "document",
			eventType: "document_refined",
			subjectId: "family-brief",
			observedAt: Date.UTC(2026, 3, 2),
		});
		await recordMemoryEvent({
			eventKey: "document_refined:family-brief:2",
			userId: "user-1",
			domain: "document",
			eventType: "document_refined",
			subjectId: "family-brief",
			observedAt: Date.UTC(2026, 3, 4),
		});
		await recordMemoryEvent({
			eventKey: "document_refined:family-slides:1",
			userId: "user-1",
			domain: "document",
			eventType: "document_refined",
			subjectId: "family-slides",
			observedAt: Date.UTC(2026, 2, 10),
		});

		const counts = await countRecentMemoryEventsBySubject({
			userId: "user-1",
			domain: "document",
			eventTypes: ["document_refined"],
			subjectIds: ["family-brief", "family-slides"],
			since: Date.UTC(2026, 3, 1),
		});

		expect(counts.get("family-brief")).toBe(2);
		expect(counts.has("family-slides")).toBe(false);
	});
});

describe("pruneOldMemoryEvents", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
	});

	function makeRow(
		overrides: Partial<MemoryEventRow> & { id: string; userId: string },
	): MemoryEventRow {
		return {
			eventKey:
				overrides.eventKey ?? `u:${overrides.userId}:test:${overrides.id}`,
			conversationId: null,
			messageId: null,
			domain: "task",
			eventType: "project_started",
			subjectId: null,
			relatedId: null,
			observedAt: new Date(),
			payloadJson: null,
			createdAt: new Date(),
			...overrides,
		};
	}

	it("deletes events older than the default 90-day cutoff while keeping recent events", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		rows.push(
			makeRow({
				id: "old-1",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 100 * 86400000),
			}),
			makeRow({
				id: "recent-1",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 10 * 86400000),
			}),
		);

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 0,
		});

		expect(result.deletedCount).toBe(1);
		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("recent-1");
	});

	it("keeps at least keepPerSubject latest events per subject even if they are old", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		// 5 old events for proj-1 (oldest first)
		for (let i = 0; i < 5; i++) {
			rows.push(
				makeRow({
					id: `old-proj1-${i}`,
					userId: "user-1",
					subjectId: "proj-1",
					observedAt: new Date(Date.now() - (200 - i) * 86400000),
				}),
			);
		}

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 3,
		});

		// keepPerSubject=3 means the 3 most recent of the 5 old events survive
		expect(result.deletedCount).toBe(2);

		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(3);
		// The 3 survivors should be the most recent (old-proj1-2, old-proj1-3, old-proj1-4)
		const survivorIds = remaining.map((e) => e.id).sort();
		expect(survivorIds).toEqual(["old-proj1-2", "old-proj1-3", "old-proj1-4"]);
	});

	it("does not delete events belonging to other users", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		rows.push(
			makeRow({
				id: "old-user1",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 100 * 86400000),
			}),
			makeRow({
				id: "old-user2",
				userId: "user-2",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 100 * 86400000),
			}),
		);

		await pruneOldMemoryEvents({ userId: "user-1" });

		const user2Events = await listMemoryEvents({ userId: "user-2", limit: 10 });
		expect(user2Events).toHaveLength(1);
		expect(user2Events[0].id).toBe("old-user2");
	});

	it("respects custom olderThanDays parameter", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		rows.push(
			makeRow({
				id: "old-40d",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 40 * 86400000),
			}),
			makeRow({
				id: "old-20d",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 20 * 86400000),
			}),
		);

		// With olderThanDays=30, only the 40d event should be pruned
		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			olderThanDays: 30,
			keepPerSubject: 0,
		});

		expect(result.deletedCount).toBe(1);
		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("old-20d");
	});

	it("keepPerSubject=0 deletes all old events regardless of subject", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		rows.push(
			makeRow({
				id: "old-1",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 100 * 86400000),
			}),
			makeRow({
				id: "old-2",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 95 * 86400000),
			}),
		);

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 0,
		});

		expect(result.deletedCount).toBe(2);
		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(0);
	});

	it("handles empty table gracefully", async () => {
		const { pruneOldMemoryEvents } = await import("./memory-events");

		const result = await pruneOldMemoryEvents({ userId: "user-1" });

		expect(result.deletedCount).toBe(0);
		expect(rows).toHaveLength(0);
	});

	it("returns deletedCount matching the number of removed rows", async () => {
		const { pruneOldMemoryEvents } = await import("./memory-events");

		rows.push(
			makeRow({
				id: "a",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 200 * 86400000),
			}),
			makeRow({
				id: "b",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 180 * 86400000),
			}),
			makeRow({
				id: "c",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 150 * 86400000),
			}),
			makeRow({
				id: "d",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 120 * 86400000),
			}),
			makeRow({
				id: "e",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 5 * 86400000),
			}),
		);

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 2,
		});

		// 5 events total. 2 most recent are protected. 3 old are deleted.
		expect(result.deletedCount).toBe(3);
	});

	it("protects events with null subjectId by keepPerSubject count", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		rows.push(
			makeRow({
				id: "null-1",
				userId: "user-1",
				subjectId: null,
				observedAt: new Date(Date.now() - 200 * 86400000),
			}),
			makeRow({
				id: "null-2",
				userId: "user-1",
				subjectId: null,
				observedAt: new Date(Date.now() - 180 * 86400000),
			}),
			makeRow({
				id: "null-3",
				userId: "user-1",
				subjectId: null,
				observedAt: new Date(Date.now() - 150 * 86400000),
			}),
		);

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 2,
		});

		// 3 null-subject events, keep 2 newest, delete 1 oldest
		expect(result.deletedCount).toBe(1);

		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(2);
		const survivorIds = remaining.map((e) => e.id).sort();
		expect(survivorIds).toEqual(["null-2", "null-3"]);
	});

	it("protects per-subject counts independently across different subjects", async () => {
		const { pruneOldMemoryEvents, listMemoryEvents } = await import(
			"./memory-events"
		);

		// proj-1: 3 old events
		rows.push(
			makeRow({
				id: "p1-1",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 200 * 86400000),
			}),
			makeRow({
				id: "p1-2",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 180 * 86400000),
			}),
			makeRow({
				id: "p1-3",
				userId: "user-1",
				subjectId: "proj-1",
				observedAt: new Date(Date.now() - 150 * 86400000),
			}),
		);
		// proj-2: 2 old events
		rows.push(
			makeRow({
				id: "p2-1",
				userId: "user-1",
				subjectId: "proj-2",
				observedAt: new Date(Date.now() - 190 * 86400000),
			}),
			makeRow({
				id: "p2-2",
				userId: "user-1",
				subjectId: "proj-2",
				observedAt: new Date(Date.now() - 140 * 86400000),
			}),
		);

		const result = await pruneOldMemoryEvents({
			userId: "user-1",
			keepPerSubject: 2,
		});

		// proj-1: keep 2, delete 1
		// proj-2: keep 2, delete 0
		expect(result.deletedCount).toBe(1);

		const remaining = await listMemoryEvents({ userId: "user-1", limit: 10 });
		expect(remaining).toHaveLength(4);

		// proj-1 survivors: p1-2, p1-3 (the 2 most recent)
		const p1Survivors = remaining
			.filter((e) => e.subjectId === "proj-1")
			.map((e) => e.id)
			.sort();
		expect(p1Survivors).toEqual(["p1-2", "p1-3"]);

		// proj-2 survivors: both (since only 2 exist)
		const p2Survivors = remaining
			.filter((e) => e.subjectId === "proj-2")
			.map((e) => e.id)
			.sort();
		expect(p2Survivors).toEqual(["p2-1", "p2-2"]);
	});
});
