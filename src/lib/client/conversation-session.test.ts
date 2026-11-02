import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "$lib/server/services/knowledge/types";
import {
	cleanupPreparedConversation,
	clearConversationSessionState,
	consumePendingConversationMessage,
	consumePreviousConversationId,
	createConversationDraftRecord,
	createDraftPersistence,
	getConversationModelSelection,
	getConversationPersonalitySelection,
	getLandingDraftConversationId,
	hasPendingConversationMessage,
	markPreviousConversationId,
	readComposerMarks,
	setConversationModelSelection,
	setConversationPersonalitySelection,
	setLandingDraftConversationId,
	storeComposerMarks,
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
			projectId: null,
			linkedSources: [],
			pendingSkill: null,
			modelId: undefined,
			personalityProfileId: null,
			reasoningDepth: "thorough",
			forceWebSearch: false,
			atlasMode: false,
			atlasProfile: null,
			atlasAction: "create",
			clientAtlasTurnId: null,
		});
		expect(hasPendingConversationMessage("conv-123")).toBe(false);
	});

	it("preserves Atlas mode on pending bootstrap messages", () => {
		storePendingConversationMessage("conv-123", {
			message: "Create an Atlas",
			attachmentIds: [],
			attachments: [],
			atlasMode: true,
			atlasProfile: "in-depth",
			atlasAction: "create",
			clientAtlasTurnId: "atlas-client-1",
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				message: "Create an Atlas",
				atlasMode: true,
				atlasProfile: "in-depth",
				atlasAction: "create",
				clientAtlasTurnId: "atlas-client-1",
			}),
		);
	});

	it("preserves the enabledConnectionCapabilities selection on pending bootstrap messages", () => {
		storePendingConversationMessage("conv-123", {
			message: "Use my files",
			attachmentIds: [],
			attachments: [],
			enabledConnectionCapabilities: ["files", "calendar"],
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				message: "Use my files",
				enabledConnectionCapabilities: ["files", "calendar"],
			}),
		);
	});

	it("omits enabledConnectionCapabilities when the composer sent none", () => {
		storePendingConversationMessage("conv-123", {
			message: "Nothing special",
			attachmentIds: [],
			attachments: [],
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				enabledConnectionCapabilities: undefined,
			}),
		);
	});

	it("carries the project of a first message sent from a project page", () => {
		storePendingConversationMessage("conv-123", {
			message: "Which train should I take?",
			attachmentIds: [],
			attachments: [],
			projectId: "project-vienna",
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({ projectId: "project-vienna" }),
		);
	});

	it("reads a pending message stored before projects existed as no project", () => {
		// A message written by an older build has no `projectId` key at all;
		// it must read as "no project" rather than as undefined leaking out.
		window.sessionStorage.setItem(
			"pending-chat-message:conv-legacy",
			JSON.stringify({
				message: "Legacy pending message",
				attachmentIds: [],
				attachments: [],
			}),
		);

		expect(consumePendingConversationMessage("conv-legacy")).toEqual(
			expect.objectContaining({ projectId: null }),
		);
	});

	it("preserves Reasoning depth on pending bootstrap messages", () => {
		storePendingConversationMessage("conv-123", {
			message: "Think about this",
			attachmentIds: [],
			attachments: [],
			reasoningDepth: "thorough",
		});

		expect(consumePendingConversationMessage("conv-123")).toEqual(
			expect.objectContaining({
				message: "Think about this",
				reasoningDepth: "thorough",
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
				reasoningDepth: "thorough",
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

	// The chat page is reused when the person moves to another chat: it saves what
	// was typed in the chat it leaves, then drops whatever else is waiting.
	describe("leaving a chat with a save still waiting out its delay", () => {
		const draftUrl = (id: string) => `/api/conversations/${id}/draft`;
		const save = (conversationId: string, draftText: string) => ({
			conversationId,
			draftText,
			selectedAttachmentIds: [],
		});
		const puts = (fetchMock: ReturnType<typeof vi.fn>) =>
			fetchMock.mock.calls
				.filter(([, init]) => init?.method === "PUT")
				.map(([input, init]) => [
					input,
					JSON.parse(String(init.body)).draftText,
				]);

		it("loses the save when the pending one is only cleared", async () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-a", "for A"));

			persistence.clear();
			await vi.advanceTimersByTimeAsync(400);

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("sends the save to the chat it was typed in when it is flushed before the clear, and nothing twice", async () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-a", "for A"));

			void persistence.flush();
			persistence.clear();
			await vi.advanceTimersByTimeAsync(400);

			expect(puts(fetchMock)).toEqual([[draftUrl("conv-a"), "for A"]]);
		});

		it("sends the flush before the clear can drop it, in the same turn of the event loop", () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-a", "for A"));

			void persistence.flush();

			// Without awaiting anything: the page clears straight after.
			expect(puts(fetchMock)).toEqual([[draftUrl("conv-a"), "for A"]]);
		});

		it("leaves a save that was already sent standing", async () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-a", "for A"));
			await vi.advanceTimersByTimeAsync(400);
			expect(puts(fetchMock)).toHaveLength(1);

			await persistence.flush();
			persistence.clear();
			await vi.advanceTimersByTimeAsync(400);

			expect(puts(fetchMock)).toEqual([[draftUrl("conv-a"), "for A"]]);
		});

		it("saves the next chat's words under the next chat", async () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-a", "for A"));
			void persistence.flush();
			persistence.clear();

			void persistence.persist(save("conv-b", "for B"));
			await vi.advanceTimersByTimeAsync(400);

			expect(puts(fetchMock)).toEqual([
				[draftUrl("conv-a"), "for A"],
				[draftUrl("conv-b"), "for B"],
			]);
		});
	});

	describe("a delete and the saves on their way", () => {
		const draftUrl = (id: string) => `/api/conversations/${id}/draft`;

		/** A fetch whose saves wait to be answered; a delete is answered at once. */
		function heldSaves() {
			const answers: Array<() => void> = [];
			const fetchMock = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					init?.method === "DELETE"
						? Promise.resolve(new Response(null, { status: 200 }))
						: new Promise<Response>((resolve) => {
								answers.push(() =>
									resolve(new Response(null, { status: 200 })),
								);
							}),
			);
			const deletes = () =>
				fetchMock.mock.calls
					.filter(([, init]) => init?.method === "DELETE")
					.map(([input]) => input);
			const answerAll = async () => {
				for (const answer of answers.splice(0)) answer();
				await new Promise((resolve) => setTimeout(resolve, 0));
			};
			return { fetchMock, deletes, answerAll };
		}

		const save = (conversationId: string, draftText: string) => ({
			conversationId,
			draftText,
			selectedAttachmentIds: [],
		});

		it("deletes at once, and again when a save on its way has been answered", async () => {
			const { fetchMock, deletes, answerAll } = heldSaves();
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-123", "an earlier version"), true);

			// The landing page navigates straight after this: nothing may wait.
			void persistence.deleteDraft("conv-123");
			expect(deletes()).toEqual([draftUrl("conv-123")]);

			await answerAll();
			expect(deletes()).toEqual([draftUrl("conv-123"), draftUrl("conv-123")]);
		});

		it("does the same for the delete of an emptied draft", async () => {
			const { fetchMock, deletes, answerAll } = heldSaves();
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-123", "an earlier version"), true);

			void persistence.persist(save("conv-123", ""));
			expect(deletes()).toEqual([draftUrl("conv-123")]);

			await answerAll();
			expect(deletes()).toEqual([draftUrl("conv-123"), draftUrl("conv-123")]);
		});

		it("deletes behind a save that failed", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error("offline"))
				.mockResolvedValue(new Response(null, { status: 200 }));
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-123", "an earlier version"), true);

			await persistence.deleteDraft("conv-123");

			expect(fetchMock).toHaveBeenLastCalledWith(draftUrl("conv-123"), {
				method: "DELETE",
			});
		});

		it("does not delete again over what this chat saved after the first delete", async () => {
			const { fetchMock, deletes, answerAll } = heldSaves();
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-123", "an earlier version"), true);
			void persistence.deleteDraft("conv-123");

			void persistence.persist(save("conv-123", "typed since"), true);

			await answerAll();
			expect(deletes()).toEqual([draftUrl("conv-123")]);
		});

		it("does not take another chat's save for words typed in this one", async () => {
			const { fetchMock, deletes, answerAll } = heldSaves();
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persist(save("conv-123", "an earlier version"), true);
			void persistence.deleteDraft("conv-123");

			void persistence.persist(save("conv-456", "another chat"), true);

			await answerAll();
			expect(deletes()).toEqual([draftUrl("conv-123"), draftUrl("conv-123")]);
		});

		it("deletes once when no save is on its way", async () => {
			const { fetchMock, deletes } = heldSaves();
			const persistence = createDraftPersistence(fetchMock, 400);

			await persistence.deleteDraft("conv-123");

			expect(deletes()).toEqual([draftUrl("conv-123")]);
		});

		it("never rejects, so a failed delete cannot surface in the page", async () => {
			const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
			const persistence = createDraftPersistence(fetchMock, 400);

			await expect(
				persistence.deleteDraft("conv-123"),
			).resolves.toBeUndefined();
		});
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

describe("marks across the hand-off and a reload", () => {
	const box = { letter: "A" as const, x: 0.1, y: 0.1, w: 0.3, h: 0.3 };

	beforeEach(() => sessionStorage.clear());

	it("carries boxes drawn on the landing page into the first message", () => {
		storePendingConversationMessage("conv-m", {
			message: "Put a lamp here",
			attachmentIds: ["photo-1"],
			attachments: [],
			imageMarks: { uploadArtifactId: "photo-1", marks: [box] },
			markedPicture: {
				artifactId: "photo-1",
				name: "room.jpg",
				addedRef: false,
				version: null,
			},
		});

		const pending = consumePendingConversationMessage("conv-m");

		expect(pending?.imageMarks).toEqual({
			uploadArtifactId: "photo-1",
			marks: [box],
		});
		expect(pending?.markedPicture).toEqual({
			artifactId: "photo-1",
			name: "room.jpg",
			addedRef: false,
			version: null,
		});
	});

	it("forgets every chat's boxes when the session ends", () => {
		storeComposerMarks("conv-s", {
			uploadArtifactId: "photo-1",
			marks: [box],
			artifactId: "photo-1",
			name: "room.jpg",
			version: null,
		});

		clearConversationSessionState();

		expect(readComposerMarks("conv-s")).toBeNull();
	});

	it("gives a message with no marks none", () => {
		storePendingConversationMessage("conv-n", {
			message: "Hello",
			attachmentIds: [],
			attachments: [],
		});
		expect(
			consumePendingConversationMessage("conv-n")?.imageMarks,
		).toBeUndefined();
	});

	it("keeps a chat's boxes through a reload, and forgets them once let go", () => {
		const marks = {
			uploadArtifactId: "photo-1",
			marks: [box],
			artifactId: "photo-1",
			name: "room.jpg",
			version: null,
		};
		storeComposerMarks("conv-r", marks);
		expect(readComposerMarks("conv-r")).toEqual(marks);
		expect(readComposerMarks("other")).toBeNull();

		storeComposerMarks("conv-r", null);
		expect(readComposerMarks("conv-r")).toBeNull();
	});
});
