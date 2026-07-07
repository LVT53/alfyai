import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMemoryProfileReadModel = vi.fn();
const mockMarkMemoryDirty = vi.fn();
const mockRecordMemoryReworkTelemetry = vi.fn();
const mockUpdateMemoryProfileItemWithRevision = vi.fn();
const mockApplyMemoryReviewItemWithRevision = vi.fn();
const mockRunUserMemoryMaintenance = vi.fn();
const mockListPersonaMemories = vi.fn();
const mockListTaskMemoryItems = vi.fn();
const mockListFocusContinuityItems = vi.fn();
const mockGetPeerContext = vi.fn();

vi.mock("./memory-profile", () => ({
	applyMemoryReviewItemWithRevision: mockApplyMemoryReviewItemWithRevision,
	getMemoryProfileReadModel: mockGetMemoryProfileReadModel,
	markMemoryDirty: mockMarkMemoryDirty,
	recordMemoryReworkTelemetry: mockRecordMemoryReworkTelemetry,
	updateMemoryProfileItemWithRevision: mockUpdateMemoryProfileItemWithRevision,
}));

vi.mock("./memory-maintenance", () => ({
	runUserMemoryMaintenance: mockRunUserMemoryMaintenance,
}));

vi.mock("./honcho", () => ({
	getPeerContext: mockGetPeerContext,
	listPersonaMemories: mockListPersonaMemories,
}));

vi.mock("./task-state", () => ({
	listFocusContinuityItems: mockListFocusContinuityItems,
	listTaskMemoryItems: mockListTaskMemoryItems,
}));

const projectionProfile = {
	resetGeneration: 0,
	projectionRevision: 7,
	categories: [
		{
			category: "about_you",
			items: [
				{
					id: "item-about",
					itemKey: "memory-profile-item:v1:about_you:global:item-about",
					category: "about_you",
					statement: "Lives in Amsterdam.",
					scope: { type: "global" },
					status: "active",
					revision: 1,
					updatedAt: new Date("2026-06-01T10:00:00.000Z"),
					canEdit: true,
					canDelete: true,
					canSuppress: true,
				},
			],
		},
		{ category: "preferences", items: [] },
		{ category: "goals_ongoing_work", items: [] },
		{ category: "constraints_boundaries", items: [] },
	],
	review: {
		visibleItems: [
			{
				id: "review-1",
				subject: "preferred language",
				question: "Which language should be remembered?",
				reason: "Conflicting evidence.",
				canAccept: true,
			},
		],
		openCount: 4,
		overflowCount: 1,
	},
};

const publicProfile = {
	...projectionProfile,
	categories: projectionProfile.categories.map((group) => ({
		...group,
		items: group.items.map((item) => ({
			...item,
			updatedAt: item.updatedAt.toISOString(),
			expiresAt: null,
		})),
	})),
};

const emptyProjectionProfile = {
	...projectionProfile,
	projectionRevision: 1,
	categories: projectionProfile.categories.map((group) => ({
		...group,
		items: [],
	})),
	review: {
		visibleItems: [],
		openCount: 0,
		overflowCount: 0,
	},
};

describe("knowledge memory service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetMemoryProfileReadModel.mockResolvedValue(projectionProfile);
		mockMarkMemoryDirty.mockResolvedValue({
			id: "dirty-1",
			reason: "stale_projection",
			count: 1,
		});
		mockRecordMemoryReworkTelemetry.mockResolvedValue({ id: "telemetry-1" });
		mockUpdateMemoryProfileItemWithRevision.mockResolvedValue({
			status: "updated",
			projectionRevision: 8,
		});
		mockApplyMemoryReviewItemWithRevision.mockResolvedValue({
			status: "updated",
			projectionRevision: 8,
			itemId: "item-review-1",
			category: "preferences",
		});
		mockRunUserMemoryMaintenance.mockResolvedValue(undefined);
	});

	it("returns the projection-backed memory profile and marks stale projection work without loading legacy memory", async () => {
		const { getKnowledgeMemory } = await import("./memory");

		const payload = await getKnowledgeMemory("user-1", "Test User");
		const payloadJson = JSON.stringify(payload);

		expect(payload).toEqual(publicProfile);
		expect(mockGetMemoryProfileReadModel).toHaveBeenCalledWith({
			userId: "user-1",
		});
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "stale_projection",
			scope: { type: "global" },
			metadata: {
				source: "knowledge_memory_read",
			},
		});
		expect(mockGetPeerContext).not.toHaveBeenCalled();
		expect(mockListPersonaMemories).not.toHaveBeenCalled();
		expect(mockListTaskMemoryItems).not.toHaveBeenCalled();
		expect(mockListFocusContinuityItems).not.toHaveBeenCalled();
		expect(mockRunUserMemoryMaintenance).not.toHaveBeenCalled();
		expect(payloadJson).not.toContain("taskMemories");
		expect(payloadJson).not.toContain("focusContinuities");
		expect(payloadJson).not.toContain("personaMemories");
		expect(payloadJson).not.toContain("honcho");
		expect(payloadJson).not.toContain("confidence");
		expect(payloadJson).not.toContain("debug");
	});

	it("queues legacy migration without blocking an empty projection-backed memory profile read", async () => {
		const maintenancePromise = new Promise<void>(() => {});
		mockRunUserMemoryMaintenance.mockReturnValueOnce(maintenancePromise);
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(emptyProjectionProfile);
		const { getKnowledgeMemory } = await import("./memory");

		const payload = await getKnowledgeMemory("user-1", "Test User");

		expect(payload.categories.flatMap((group) => group.items)).toEqual([]);
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "stale_projection",
			scope: { type: "global" },
			metadata: {
				source: "knowledge_memory_read",
			},
		});
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "legacy_migration",
			scope: { type: "global" },
			metadata: {
				source: "knowledge_memory_read",
			},
		});
		await vi.waitFor(() => {
			expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
				"user-1",
				"knowledge_memory_read",
			);
		});
		expect(mockGetMemoryProfileReadModel).toHaveBeenCalledTimes(1);
	});

	it("keeps forced overview refresh cheap by reading the projection and marking stale work", async () => {
		const { getKnowledgeMemoryOverview } = await import("./memory");

		const payload = await getKnowledgeMemoryOverview("user-1", "Test User", {
			force: true,
		});
		const payloadJson = JSON.stringify(payload);

		expect(payload.profile?.categories).toHaveLength(4);
		expect(payload.summary.taskCount).toBe(0);
		expect(payload.summary.focusContinuityCount).toBe(0);
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "stale_projection",
			scope: { type: "global" },
			metadata: {
				source: "knowledge_memory_overview_force_read",
			},
		});
		expect(mockGetPeerContext).not.toHaveBeenCalled();
		expect(mockListPersonaMemories).not.toHaveBeenCalled();
		expect(mockListTaskMemoryItems).not.toHaveBeenCalled();
		expect(mockListFocusContinuityItems).not.toHaveBeenCalled();
		expect(payloadJson).not.toContain("taskMemories");
		expect(payloadJson).not.toContain("focusContinuities");
		expect(payloadJson).not.toContain("honcho");
	});

	it("deletes a profile item with projection revision protection and queues reconciliation", async () => {
		const afterDeleteProfile = {
			...projectionProfile,
			projectionRevision: 8,
			categories: projectionProfile.categories.map((group) => ({
				...group,
				items: [],
			})),
		};
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(afterDeleteProfile);
		const { applyKnowledgeMemoryAction } = await import("./memory");

		const payload = await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "delete",
			itemId: "item-about",
			expectedProjectionRevision: 7,
		});
		const payloadJson = JSON.stringify(payload);

		expect(mockUpdateMemoryProfileItemWithRevision).toHaveBeenCalledWith({
			userId: "user-1",
			itemId: "item-about",
			expectedProjectionRevision: 7,
			patch: { status: "deleted" },
		});
		expect(payload.projectionRevision).toBe(8);
		expect(payload.categories.flatMap((group) => group.items)).toEqual([]);
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "profile_action_reconciliation",
			scope: { type: "global" },
			metadata: {
				action: "delete",
				itemId: "item-about",
			},
		});
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "projection_reconciliation",
			scope: { type: "global" },
			metadata: {
				action: "delete",
				itemId: "item-about",
			},
		});
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith({
			userId: "user-1",
			eventFamily: "profile_action",
			eventName: "memory_profile_delete",
			reason: "user_action",
			status: "updated",
			subjectId: "item-about",
			metadata: {
				action: "delete",
			},
		});
		expect(payloadJson).not.toContain("Lives in Amsterdam");
		expect(payloadJson).not.toContain("taskMemories");
		expect(payloadJson).not.toContain("focusContinuities");
	});

	it("suppresses a profile item with projection revision protection and queues reconciliation", async () => {
		const afterSuppressProfile = {
			...projectionProfile,
			projectionRevision: 8,
			categories: projectionProfile.categories.map((group) => ({
				...group,
				items: [],
			})),
		};
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(afterSuppressProfile);
		const { applyKnowledgeMemoryAction } = await import("./memory");

		const payload = await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "suppress",
			itemId: "item-about",
			expectedProjectionRevision: 7,
		});
		const payloadJson = JSON.stringify(payload);

		expect(mockUpdateMemoryProfileItemWithRevision).toHaveBeenCalledWith({
			userId: "user-1",
			itemId: "item-about",
			expectedProjectionRevision: 7,
			patch: { status: "suppressed" },
		});
		expect(payload.projectionRevision).toBe(8);
		expect(payload.categories.flatMap((group) => group.items)).toEqual([]);
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "profile_action_reconciliation",
			scope: { type: "global" },
			metadata: {
				action: "suppress",
				itemId: "item-about",
			},
		});
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "projection_reconciliation",
			scope: { type: "global" },
			metadata: {
				action: "suppress",
				itemId: "item-about",
			},
		});
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith({
			userId: "user-1",
			eventFamily: "profile_action",
			eventName: "memory_profile_suppress",
			reason: "user_action",
			status: "updated",
			subjectId: "item-about",
			metadata: {
				action: "suppress",
			},
		});
		expect(payloadJson).not.toContain("Lives in Amsterdam");
		expect(payloadJson).not.toContain("taskMemories");
		expect(payloadJson).not.toContain("focusContinuities");
	});

	it("edits a profile item immediately and rejects stale projection revisions", async () => {
		const afterEditProfile = {
			...projectionProfile,
			projectionRevision: 8,
			categories: projectionProfile.categories.map((group) => ({
				...group,
				items: group.items.map((item) => ({
					...item,
					statement: "Lives in Rotterdam.",
					revision: 2,
				})),
			})),
		};
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(afterEditProfile);
		const { MemoryProfileActionError, applyKnowledgeMemoryAction } =
			await import("./memory");

		await expect(
			applyKnowledgeMemoryAction("user-1", "Test User", {
				action: "edit",
				itemId: "item-about",
				statement: "Lives in Rotterdam.",
				expectedProjectionRevision: 7,
			}),
		).resolves.toMatchObject({
			projectionRevision: 8,
			categories: [
				expect.objectContaining({
					items: [
						expect.objectContaining({
							statement: "Lives in Rotterdam.",
						}),
					],
				}),
				expect.any(Object),
				expect.any(Object),
				expect.any(Object),
			],
		});
		expect(mockUpdateMemoryProfileItemWithRevision).toHaveBeenCalledWith({
			userId: "user-1",
			itemId: "item-about",
			expectedProjectionRevision: 7,
			patch: { statement: "Lives in Rotterdam." },
		});
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				eventFamily: "profile_action",
				eventName: "memory_profile_edit",
				metadata: { action: "edit" },
			}),
		);

		mockUpdateMemoryProfileItemWithRevision.mockResolvedValueOnce({
			status: "stale_projection",
		});
		await expect(
			applyKnowledgeMemoryAction("user-1", "Test User", {
				action: "edit",
				itemId: "item-about",
				statement: "Should not win.",
				expectedProjectionRevision: 7,
			}),
		).rejects.toMatchObject({
			constructor: MemoryProfileActionError,
			code: "stale_projection",
			status: 409,
		});
		expect(mockGetMemoryProfileReadModel).toHaveBeenCalledTimes(1);
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith({
			userId: "user-1",
			eventFamily: "profile_action",
			eventName: "memory_profile_edit",
			reason: "user_action",
			status: "stale_projection",
			subjectId: "item-about",
			metadata: {
				action: "edit",
			},
		});
		const telemetryCallsJson = JSON.stringify(
			mockRecordMemoryReworkTelemetry.mock.calls,
		);
		expect(telemetryCallsJson).not.toContain("Lives in Rotterdam");
		expect(telemetryCallsJson).not.toContain("Should not win");
	});

	it("rejects unknown action targets before applying profile updates", async () => {
		const { MemoryProfileActionError, applyKnowledgeMemoryAction } =
			await import("./memory");

		await expect(
			applyKnowledgeMemoryAction("user-1", "Test User", {
				target: "unknown_item",
				action: "delete",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			}),
		).rejects.toMatchObject({
			constructor: MemoryProfileActionError,
			code: "invalid_action",
			status: 400,
		});

		expect(mockUpdateMemoryProfileItemWithRevision).not.toHaveBeenCalled();
		expect(mockApplyMemoryReviewItemWithRevision).not.toHaveBeenCalled();
	});

	it("accepts a review item into the profile and queues safe reconciliation work", async () => {
		const afterAcceptProfile = {
			...projectionProfile,
			projectionRevision: 8,
			categories: projectionProfile.categories.map((group) =>
				group.category === "preferences"
					? {
							...group,
							items: [
								{
									id: "item-review-1",
									itemKey:
										"memory-profile-item:v1:preferences:global:item-review-1",
									category: "preferences",
									statement: "Remember Hungarian labels.",
									scope: { type: "global" },
									status: "active",
									revision: 0,
									updatedAt: new Date("2026-06-01T11:00:00.000Z"),
									canEdit: true,
									canDelete: true,
									canSuppress: true,
								},
							],
						}
					: group,
			),
			review: {
				visibleItems: [],
				openCount: 0,
				overflowCount: 0,
			},
		};
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(afterAcceptProfile);
		const { applyKnowledgeMemoryAction } = await import("./memory");

		const payload = await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "accept",
			target: "review_item",
			itemId: "review-1",
			expectedProjectionRevision: 7,
		});
		const telemetryCallsJson = JSON.stringify(
			mockRecordMemoryReworkTelemetry.mock.calls,
		);

		expect(mockApplyMemoryReviewItemWithRevision).toHaveBeenCalledWith({
			userId: "user-1",
			reviewItemId: "review-1",
			expectedProjectionRevision: 7,
			action: "accept",
		});
		expect(mockUpdateMemoryProfileItemWithRevision).not.toHaveBeenCalled();
		expect(payload.projectionRevision).toBe(8);
		expect(payload.review.visibleItems).toEqual([]);
		expect(mockMarkMemoryDirty).toHaveBeenCalledWith({
			userId: "user-1",
			reason: "profile_action_reconciliation",
			scope: { type: "global" },
			metadata: {
				action: "accept",
				itemId: "item-review-1",
				reviewItemId: "review-1",
			},
		});
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith({
			userId: "user-1",
			eventFamily: "guided_review",
			eventName: "memory_review_accept",
			category: "preferences",
			reason: "user_action",
			status: "updated",
			subjectId: "review-1",
			metadata: {
				action: "accept",
				itemId: "item-review-1",
			},
		});
		expect(telemetryCallsJson).not.toContain("Remember Hungarian labels");
	});

	it("edits a review item using the edited statement without leaking it to telemetry", async () => {
		const afterEditProfile = {
			...projectionProfile,
			projectionRevision: 8,
			categories: projectionProfile.categories.map((group) =>
				group.category === "preferences"
					? {
							...group,
							items: [
								{
									id: "item-review-1",
									itemKey:
										"memory-profile-item:v1:preferences:global:item-review-1",
									category: "preferences",
									statement: "Prefers Hungarian UI labels.",
									scope: { type: "global" },
									status: "active",
									revision: 0,
									updatedAt: new Date("2026-06-01T11:00:00.000Z"),
									canEdit: true,
									canDelete: true,
									canSuppress: true,
								},
							],
						}
					: group,
			),
			review: {
				visibleItems: [],
				openCount: 0,
				overflowCount: 0,
			},
		};
		mockGetMemoryProfileReadModel.mockResolvedValueOnce(afterEditProfile);
		const { applyKnowledgeMemoryAction } = await import("./memory");

		const payload = await applyKnowledgeMemoryAction("user-1", "Test User", {
			target: "review_item",
			action: "edit",
			itemId: "review-1",
			statement: "Prefers Hungarian UI labels.",
			expectedProjectionRevision: 7,
		});
		const telemetryCallsJson = JSON.stringify(
			mockRecordMemoryReworkTelemetry.mock.calls,
		);

		expect(mockApplyMemoryReviewItemWithRevision).toHaveBeenCalledWith({
			userId: "user-1",
			reviewItemId: "review-1",
			expectedProjectionRevision: 7,
			action: "edit",
			statement: "Prefers Hungarian UI labels.",
		});
		expect(payload.categories[1]?.items[0]?.statement).toBe(
			"Prefers Hungarian UI labels.",
		);
		expect(mockRecordMemoryReworkTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({
				eventFamily: "guided_review",
				eventName: "memory_review_edit",
				subjectId: "review-1",
				metadata: {
					action: "edit",
					itemId: "item-review-1",
				},
			}),
		);
		expect(telemetryCallsJson).not.toContain("Prefers Hungarian UI labels");
	});
});
