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

// Shared state for mock
let queryConditions: Array<{ field: string; value: string | string[] }> = [];

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
				onConflictDoUpdate: vi.fn(async () => undefined),
			}),
		}),
		select: () => ({
			from: () => ({
				where: (
					conditions: Array<{ field: string; value: string | string[] }>,
				) => {
					queryConditions = conditions;
					return {
						orderBy: () => ({
							limit: async (count: number) =>
								rows
									.slice()
									.filter((row) =>
										queryConditions.every((condition) => {
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
					};
				},
			}),
		}),
		delete: () => ({
			where: vi.fn(async () => undefined),
		}),
		update: () => ({
			set: () => ({
				where: vi.fn(async () => undefined),
			}),
		}),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	memoryEvents: {
		eventKey: { name: "eventKey" },
		userId: { name: "userId" },
		domain: { name: "domain" },
		eventType: { name: "eventType" },
		subjectId: { name: "subjectId" },
		observedAt: { name: "observedAt" },
		conversationId: { name: "conversationId" },
		messageId: { name: "messageId" },
		relatedId: { name: "relatedId" },
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
	parseJsonStringArray: vi.fn(() => []),
}));

describe("memory-behavior-log learning - recordMemoryBehaviorEvent", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
	});

	it("stores events with correct domain", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:task-domain",
			userId: "user-1",
			domain: "task",
			eventType: "project_started",
			subjectId: "project-1",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].domain).toBe("task");
	});

	it("stores events with correct eventType", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:event-type",
			userId: "user-1",
			domain: "persona",
			eventType: "persona_fact_updated",
			subjectId: "memory-1",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].eventType).toBe("persona_fact_updated");
	});

	it("stores payload as JSON string", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:payload",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "deadline-1",
			payload: { priority: "high", topicKey: "assessment" },
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].payloadJson).toBe(
			'{"priority":"high","topicKey":"assessment"}',
		);
	});

	it("handles null payload gracefully", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:no-payload",
			userId: "user-1",
			domain: "task",
			eventType: "project_started",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].payloadJson).toBeNull();
	});

	it("stores conversationId and messageId when provided", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:full-context",
			userId: "user-1",
			domain: "document",
			eventType: "document_refined",
			conversationId: "conv-123",
			messageId: "msg-456",
			subjectId: "artifact-789",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].conversationId).toBe("conv-123");
		expect(rows[0].messageId).toBe("msg-456");
	});

	it("normalizes numeric observedAt to Date", async () => {
		const { recordMemoryBehaviorEvent } = await import("./memory-behavior-log");

		const timestamp = Date.UTC(2026, 3, 15, 10, 30);
		await recordMemoryBehaviorEvent({
			eventKey: "test:observed-at",
			userId: "user-1",
			domain: "task",
			eventType: "project_started",
			observedAt: timestamp,
		});

		expect(rows).toHaveLength(1);
		expect(rows[0].observedAt).toBeInstanceOf(Date);
	});
});

describe("memory-behavior-log learning - listMemoryBehaviorEvents", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
		queryConditions = [];
		// Pre-populate some events
		rows.push(
			{
				id: "event-1",
				eventKey: "u:user-1:test:event-1",
				userId: "user-1",
				domain: "task",
				eventType: "project_started",
				subjectId: "project-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 10)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-2",
				eventKey: "u:user-1:test:event-2",
				userId: "user-1",
				domain: "persona",
				eventType: "persona_fact_updated",
				subjectId: "memory-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 12)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-3",
				eventKey: "u:user-1:test:event-3",
				userId: "user-1",
				domain: "temporal",
				eventType: "deadline_set",
				subjectId: "deadline-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 11)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-4",
				eventKey: "u:user-2:test:event-4",
				userId: "user-2",
				domain: "task",
				eventType: "project_started",
				subjectId: "project-2",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 13)),
				payloadJson: null,
				createdAt: new Date(),
			},
		);
	});

	it("retrieves events ordered by observedAt descending", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});

		expect(events.length).toBe(3); // Only user-1's events
		expect(events[0].eventType).toBe("persona_fact_updated"); // Most recent
		expect(events[1].eventType).toBe("deadline_set");
		expect(events[2].eventType).toBe("project_started"); // Oldest
	});

	it("filters events by domain", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const taskEvents = await listMemoryBehaviorEvents({
			userId: "user-1",
			domain: "task",
			limit: 10,
		});

		expect(taskEvents.length).toBe(1);
		expect(taskEvents[0].domain).toBe("task");
	});

	it("filters events by subjectId", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			subjectId: "project-1",
			limit: 10,
		});

		expect(events.length).toBe(1);
		expect(events[0].subjectId).toBe("project-1");
	});

	it("filters events by multiple eventTypes", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			eventTypes: ["project_started", "persona_fact_updated"],
			limit: 10,
		});

		expect(events.length).toBe(2);
		const eventTypes = events.map((e) => e.eventType);
		expect(eventTypes).toContain("project_started");
		expect(eventTypes).toContain("persona_fact_updated");
	});

	it("respects limit parameter", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 2,
		});

		expect(events.length).toBe(2);
	});

	it("does not return events from other users", async () => {
		const { listMemoryBehaviorEvents } = await import("./memory-behavior-log");

		const user1Events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		const user2Events = await listMemoryBehaviorEvents({
			userId: "user-2",
			limit: 10,
		});

		const user1Ids = new Set(user1Events.map((e) => e.id));
		const user2Ids = new Set(user2Events.map((e) => e.id));

		// Ensure no overlap
		for (const id of user1Ids) {
			expect(user2Ids.has(id)).toBe(false);
		}
	});
});

describe("memory-behavior-log learning - event key uniqueness", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
		queryConditions = [];
	});

	it("deduplicates events by scoped event key per user", async () => {
		const { recordMemoryBehaviorEvent, listMemoryBehaviorEvents } =
			await import("./memory-behavior-log");

		// Record same event twice
		await recordMemoryBehaviorEvent({
			eventKey: "deadline_set:project-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "project-1",
		});

		await recordMemoryBehaviorEvent({
			eventKey: "deadline_set:project-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "project-1",
		});

		// Should only have one event
		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		expect(events).toHaveLength(1);
	});

	it("allows same eventKey for different users", async () => {
		const { recordMemoryBehaviorEvent, listMemoryBehaviorEvents } =
			await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "deadline_set:project-1",
			userId: "user-1",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "project-1",
		});

		await recordMemoryBehaviorEvent({
			eventKey: "deadline_set:project-1",
			userId: "user-2",
			domain: "temporal",
			eventType: "deadline_set",
			subjectId: "project-1",
		});

		const user1Events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		const user2Events = await listMemoryBehaviorEvents({
			userId: "user-2",
			limit: 10,
		});

		expect(user1Events).toHaveLength(1);
		expect(user2Events).toHaveLength(1);
	});

	it("allows same raw eventKey for different event types when scoped keys differ", async () => {
		const { recordMemoryBehaviorEvent, listMemoryBehaviorEvents } =
			await import("./memory-behavior-log");

		// Each call creates a different scoped key (u:user-1:eventType:project-1)
		await recordMemoryBehaviorEvent({
			eventKey: "project_started:project-1",
			userId: "user-1",
			domain: "task",
			eventType: "project_started",
			subjectId: "project-1",
		});

		await recordMemoryBehaviorEvent({
			eventKey: "project_paused:project-1",
			userId: "user-1",
			domain: "task",
			eventType: "project_paused",
			subjectId: "project-1",
		});

		// Both should be stored since scoped keys differ
		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		expect(events.length).toBe(2);
	});

	it("extracts payload from stored JSON", async () => {
		const { recordMemoryBehaviorEvent, listMemoryBehaviorEvents } =
			await import("./memory-behavior-log");

		await recordMemoryBehaviorEvent({
			eventKey: "test:payload-extraction",
			userId: "user-1",
			domain: "preference",
			eventType: "preference_updated",
			subjectId: "pref-1",
			payload: {
				preferenceDomain: "communication",
				preferenceSlot: "style",
				preferenceValue: "concise",
			},
		});

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		expect(events[0].payload).toBeDefined();
		expect(events[0].payload?.preferenceValue).toBe("concise");
	});
});

describe("memory-behavior-log learning - recordMemoryBehaviorEvents batch", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
		queryConditions = [];
	});

	it("records multiple events in a batch", async () => {
		const { recordMemoryBehaviorEvents } = await import(
			"./memory-behavior-log"
		);

		await recordMemoryBehaviorEvents([
			{
				eventKey: "batch:event-1",
				userId: "user-1",
				domain: "task",
				eventType: "project_started",
			},
			{
				eventKey: "batch:event-2",
				userId: "user-1",
				domain: "task",
				eventType: "project_paused",
			},
			{
				eventKey: "batch:event-3",
				userId: "user-1",
				domain: "persona",
				eventType: "persona_fact_updated",
			},
		]);

		expect(rows.length).toBe(3);
	});

	it("handles empty batch gracefully", async () => {
		const { recordMemoryBehaviorEvents } = await import(
			"./memory-behavior-log"
		);

		// Should not throw
		await recordMemoryBehaviorEvents([]);

		expect(rows.length).toBe(0);
	});

	it("applies deduplication to batch with duplicates", async () => {
		const { recordMemoryBehaviorEvents, listMemoryBehaviorEvents } =
			await import("./memory-behavior-log");

		await recordMemoryBehaviorEvents([
			{
				eventKey: "batch:duplicate-test",
				userId: "user-1",
				domain: "temporal",
				eventType: "deadline_set",
			},
			{
				eventKey: "batch:duplicate-test",
				userId: "user-1",
				domain: "temporal",
				eventType: "deadline_set",
			},
			{
				eventKey: "batch:unique-event",
				userId: "user-1",
				domain: "temporal",
				eventType: "deadline_set",
			},
		]);

		const events = await listMemoryBehaviorEvents({
			userId: "user-1",
			limit: 10,
		});
		expect(events.length).toBe(2); // One duplicate, one unique
	});
});

describe("memory-behavior-log learning - listLatestMemoryBehaviorEventsBySubject", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
		queryConditions = [];
		// Pre-populate with multiple events per subject
		rows.push(
			{
				id: "event-a1",
				eventKey: "u:user-1:project_started:proj-A",
				userId: "user-1",
				domain: "task",
				eventType: "project_started",
				subjectId: "proj-A",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 10)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-a2",
				eventKey: "u:user-1:project_paused:proj-A",
				userId: "user-1",
				domain: "task",
				eventType: "project_paused",
				subjectId: "proj-A",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 15)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-b1",
				eventKey: "u:user-1:project_started:proj-B",
				userId: "user-1",
				domain: "task",
				eventType: "project_started",
				subjectId: "proj-B",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 12)),
				payloadJson: null,
				createdAt: new Date(),
			},
		);
	});

	it("returns latest event per subject", async () => {
		const { listLatestMemoryBehaviorEventsBySubject } = await import(
			"./memory-behavior-log"
		);

		const latestBySubject = await listLatestMemoryBehaviorEventsBySubject({
			userId: "user-1",
			subjectIds: ["proj-A", "proj-B"],
		});

		expect(latestBySubject.size).toBe(2);
		expect(latestBySubject.get("proj-A")?.eventType).toBe("project_paused");
		expect(latestBySubject.get("proj-B")?.eventType).toBe("project_started");
	});

	it("returns empty map for empty subjectIds", async () => {
		const { listLatestMemoryBehaviorEventsBySubject } = await import(
			"./memory-behavior-log"
		);

		const latestBySubject = await listLatestMemoryBehaviorEventsBySubject({
			userId: "user-1",
			subjectIds: [],
		});

		expect(latestBySubject.size).toBe(0);
	});

	it("filters by eventTypes when provided", async () => {
		const { listLatestMemoryBehaviorEventsBySubject } = await import(
			"./memory-behavior-log"
		);

		const latestBySubject = await listLatestMemoryBehaviorEventsBySubject({
			userId: "user-1",
			subjectIds: ["proj-A", "proj-B"],
			eventTypes: ["project_paused"],
		});

		// proj-A has project_paused, proj-B doesn't
		expect(latestBySubject.has("proj-A")).toBe(true);
		expect(latestBySubject.get("proj-A")?.eventType).toBe("project_paused");
	});
});

describe("memory-behavior-log learning - countRecentMemoryBehaviorEventsBySubject", () => {
	beforeEach(() => {
		rows.splice(0, rows.length);
		queryConditions = [];
		rows.push(
			{
				id: "event-1",
				eventKey: "u:user-1:doc-refined:artifact-1:1",
				userId: "user-1",
				domain: "document",
				eventType: "document_refined",
				subjectId: "artifact-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 1)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-2",
				eventKey: "u:user-1:doc-refined:artifact-1:2",
				userId: "user-1",
				domain: "document",
				eventType: "document_refined",
				subjectId: "artifact-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 5)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-3",
				eventKey: "u:user-1:doc-refined:artifact-1:3",
				userId: "user-1",
				domain: "document",
				eventType: "document_refined",
				subjectId: "artifact-1",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 8)),
				payloadJson: null,
				createdAt: new Date(),
			},
			{
				id: "event-4",
				eventKey: "u:user-1:doc-refined:artifact-2:1",
				userId: "user-1",
				domain: "document",
				eventType: "document_refined",
				subjectId: "artifact-2",
				conversationId: null,
				messageId: null,
				relatedId: null,
				observedAt: new Date(Date.UTC(2026, 3, 15)),
				payloadJson: null,
				createdAt: new Date(),
			},
		);
	});

	it("counts events per subject within time window", async () => {
		const { countRecentMemoryBehaviorEventsBySubject } = await import(
			"./memory-behavior-log"
		);

		const counts = await countRecentMemoryBehaviorEventsBySubject({
			userId: "user-1",
			domain: "document",
			eventTypes: ["document_refined"],
			subjectIds: ["artifact-1", "artifact-2"],
			since: Date.UTC(2026, 2, 28), // March 1 is after Feb 28
		});

		// artifact-1 has 3 events since 2/28 (3/1, 3/5, 3/8)
		expect(counts.get("artifact-1")).toBe(3);
		// artifact-2 has 1 event (3/15)
		expect(counts.get("artifact-2")).toBe(1);
	});

	it("returns zero for subjects with no recent events", async () => {
		const { countRecentMemoryBehaviorEventsBySubject } = await import(
			"./memory-behavior-log"
		);

		// Note: The mock's listMemoryBehaviorEvents doesn't filter by 'since', so we test
		// that the function handles non-existent subjects correctly
		const counts = await countRecentMemoryBehaviorEventsBySubject({
			userId: "user-1",
			domain: "document",
			eventTypes: ["document_refined"],
			subjectIds: ["nonexistent-subject", "another-fake-id"],
		});

		// Nonexistent subjects should not be in the map
		expect(counts.has("nonexistent-subject")).toBe(false);
		expect(counts.has("another-fake-id")).toBe(false);
	});
});
