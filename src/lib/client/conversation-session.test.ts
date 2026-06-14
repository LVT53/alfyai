import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "$lib/types";
import {
	cleanupPreparedConversation,
	consumePendingConversationMessage,
	consumePreviousConversationId,
	createConversationDraftRecord,
	createDraftPersistence,
	getConversationModelSelection,
	getConversationPersonalitySelection,
	getLandingDraftConversationId,
	hasPendingConversationMessage,
	markPreviousConversationId,
	setConversationModelSelection,
	setConversationPersonalitySelection,
	setLandingDraftConversationId,
	storePendingConversationMessage,
} from "./conversation-session";

async function flushMicrotasks(turns = 3): Promise<void> {
	for (let index = 0; index < turns; index += 1) {
		await Promise.resolve();
	}
}

describe("conversation-session", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		vi.useRealTimers();
	});

	it("stores and consumes the landing return marker", () => {
		markPreviousConversationId("conv-123");

		expect(consumePreviousConversationId()).toBe("conv-123");
		expect(consumePreviousConversationId()).toBeNull();
	});

	it("stores, reads, and clears the landing draft conversation id", () => {
		setLandingDraftConversationId("conv-landing");
		expect(getLandingDraftConversationId()).toBe("conv-landing");

		setLandingDraftConversationId(null);
		expect(getLandingDraftConversationId()).toBeNull();
	});

	it("keeps chat-local personality selection separate from the profile default", () => {
		expect(getConversationPersonalitySelection("conv-123", "creative")).toBe(
			"creative",
		);

		setConversationPersonalitySelection("conv-123", "concise");
		expect(getConversationPersonalitySelection("conv-123", "creative")).toBe(
			"concise",
		);

		setConversationPersonalitySelection("conv-123", null);
		expect(
			getConversationPersonalitySelection("conv-123", "creative"),
		).toBeNull();
		expect(getConversationPersonalitySelection("conv-456", "creative")).toBe(
			"creative",
		);
	});

	it("keeps chat-local model selection separate from the profile default", () => {
		expect(getConversationModelSelection("conv-123", "model1")).toBe("model1");

		setConversationModelSelection("conv-123", "provider:local-gpt-oss");
		expect(getConversationModelSelection("conv-123", "model1")).toBe(
			"provider:local-gpt-oss",
		);

		expect(getConversationModelSelection("conv-456", "model1")).toBe("model1");
	});

	it("stores and consumes pending conversation messages", () => {
		const attachment: ArtifactSummary = {
			id: "artifact-1",
			type: "source_document",
			retrievalClass: "durable",
			name: "notes.txt",
			mimeType: "text/plain",
			sizeBytes: 12,
			conversationId: "conv-123",
			summary: "Notes",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		storePendingConversationMessage("conv-123", {
			message: "Hello there",
			attachmentIds: ["artifact-1"],
			attachments: [attachment],
		});

		expect(hasPendingConversationMessage("conv-123")).toBe(true);
		expect(consumePendingConversationMessage("conv-123")).toEqual({
			message: "Hello there",
			attachmentIds: ["artifact-1"],
			attachments: [attachment],
			linkedSources: [],
			pendingSkill: null,
			modelId: undefined,
			personalityProfileId: null,
			deepResearchDepth: null,
			reasoningDepth: "auto",
			forceWebSearch: false,
		});
		expect(hasPendingConversationMessage("conv-123")).toBe(false);
	});

	it("preserves Deep Research and Reasoning depth on pending bootstrap messages", () => {
		storePendingConversationMessage("conv-123", {
			message: "Research this deeply",
			attachmentIds: [],
			attachments: [],
			deepResearchDepth: "max",
			reasoningDepth: "max",
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				message: "Research this deeply",
				deepResearchDepth: "max",
				reasoningDepth: "max",
			}),
		);
	});

	it("maps hidden legacy pending thinking mode to Reasoning depth", () => {
		window.sessionStorage.setItem(
			"pending-chat-message:conv-legacy",
			JSON.stringify({
				message: "Legacy pending message",
				attachmentIds: [],
				attachments: [],
				thinkingMode: "on",
			}),
		);

		expect(consumePendingConversationMessage("conv-legacy")).toEqual(
			expect.objectContaining({
				message: "Legacy pending message",
				reasoningDepth: "max",
			}),
		);
	});

	it("preserves pending Skill Variant metadata through pending bootstrap messages", () => {
		storePendingConversationMessage("conv-123", {
			message: "Use this",
			attachmentIds: [],
			attachments: [],
			pendingSkill: {
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Pack variant",
				baseSkillId: "system:pack",
				baseSkillDisplayName: "Research Pack",
				unavailable: true,
			},
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				pendingSkill: {
					id: "variant-1",
					ownership: "user",
					skillKind: "skill_variant",
					displayName: "Pack variant",
					baseSkillId: "system:pack",
					baseSkillDisplayName: "Research Pack",
					unavailable: true,
				},
			}),
		);
	});

	it("builds a draft record only when the draft is meaningful", () => {
		const linkedSource = {
			displayArtifactId: "source-display",
			promptArtifactId: "source-prompt",
			familyArtifactIds: ["source-display", "source-prompt"],
			name: "Linked report.pdf",
			type: "document" as const,
		};

		expect(
			createConversationDraftRecord({
				conversationId: null,
				fallbackConversationId: "conv-fallback",
				draftText: "Draft message",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [linkedSource],
				updatedAt: 123,
			}),
		).toEqual({
			conversationId: "conv-fallback",
			draftText: "Draft message",
			selectedAttachmentIds: [],
			selectedAttachments: [],
			selectedLinkedSources: [linkedSource],
			pendingSkill: null,
			updatedAt: 123,
		});

		expect(
			createConversationDraftRecord({
				conversationId: null,
				draftText: "   ",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [linkedSource],
			}),
		).toEqual({
			conversationId: "draft",
			draftText: "   ",
			selectedAttachmentIds: [],
			selectedAttachments: [],
			selectedLinkedSources: [linkedSource],
			pendingSkill: null,
			updatedAt: expect.any(Number),
		});

		expect(
			createConversationDraftRecord({
				conversationId: "conv-skill",
				draftText: "   ",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		).toEqual({
			conversationId: "conv-skill",
			draftText: "   ",
			selectedAttachmentIds: [],
			selectedAttachments: [],
			selectedLinkedSources: [],
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
			},
			updatedAt: expect.any(Number),
		});

		expect(
			createConversationDraftRecord({
				conversationId: null,
				draftText: "   ",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
			}),
		).toBeNull();
	});

	it("debounces draft persistence and issues a PUT for meaningful drafts", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const persistence = createDraftPersistence(fetchMock, 400);

		void persistence.persist({
			conversationId: "conv-123",
			draftText: "Hello draft",
			selectedAttachmentIds: ["artifact-1"],
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
			},
			selectedLinkedSources: [
				{
					displayArtifactId: "source-display",
					promptArtifactId: "source-prompt",
					familyArtifactIds: ["source-display", "source-prompt"],
					name: "Linked report.pdf",
					type: "document",
				},
			],
		});

		expect(fetchMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(400);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-123/draft",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					draftText: "Hello draft",
					selectedAttachmentIds: ["artifact-1"],
					selectedLinkedSources: [
						{
							displayArtifactId: "source-display",
							promptArtifactId: "source-prompt",
							familyArtifactIds: ["source-display", "source-prompt"],
							name: "Linked report.pdf",
							type: "document",
						},
					],
					pendingSkill: {
						id: "skill-1",
						ownership: "user",
						displayName: "Interview coach",
					},
				}),
			},
		);
	});

	it("flushes a pending draft write immediately", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const persistence = createDraftPersistence(fetchMock, 400);

		void persistence.persist({
			conversationId: "conv-123",
			draftText: "Hello draft",
			selectedAttachmentIds: [],
			pendingSkill: null,
		});

		await persistence.flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-123/draft",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					draftText: "Hello draft",
					selectedAttachmentIds: [],
					selectedLinkedSources: [],
					pendingSkill: null,
				}),
			},
		);
	});

	it("deletes empty drafts instead of persisting them", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const persistence = createDraftPersistence(fetchMock);

		await persistence.persist(
			{
				conversationId: "conv-123",
				draftText: "",
				selectedAttachmentIds: [],
			},
			true,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-123/draft",
			{
				method: "DELETE",
			},
		);
	});

	it("deletes empty drafts immediately so cleared attachments do not restore on reload", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const persistence = createDraftPersistence(fetchMock, 400);

		await persistence.persist({
			conversationId: "conv-123",
			draftText: "",
			selectedAttachmentIds: [],
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-123/draft",
			{
				method: "DELETE",
			},
		);
	});

	it("cleans up empty prepared conversations through the shared helper", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		let resolveRemoved!: (conversationId: string) => void;
		const removed = new Promise<string>((resolve) => {
			resolveRemoved = resolve;
		});
		const removeLocal = vi.fn((conversationId: string) => {
			resolveRemoved(conversationId);
		});

		cleanupPreparedConversation({
			conversationId: "conv-123",
			removeLocal,
			fetchImpl: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-123", {
			method: "DELETE",
			keepalive: true,
		});
		await expect(removed).resolves.toBe("conv-123");
		expect(removeLocal).toHaveBeenCalledWith("conv-123");
	});

	it("keeps empty prepared conversations locally when server cleanup fails", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ error: "Failed to fully delete conversation" }),
				{
					status: 500,
				},
			),
		);
		const removeLocal = vi.fn();

		cleanupPreparedConversation({
			conversationId: "conv-123",
			removeLocal,
			fetchImpl: fetchMock,
		});

		await flushMicrotasks();

		expect(removeLocal).not.toHaveBeenCalled();
	});

	it("does not clean up a prepared conversation with a pending bootstrap message", () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		const removeLocal = vi.fn();

		storePendingConversationMessage("conv-123", {
			message: "Send this after navigation",
			attachmentIds: [],
			attachments: [],
		});

		cleanupPreparedConversation({
			conversationId: "conv-123",
			removeLocal,
			fetchImpl: fetchMock,
		});

		expect(removeLocal).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(hasPendingConversationMessage("conv-123")).toBe(true);
	});
});
