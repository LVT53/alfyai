import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "$lib/server/services/knowledge/types";
import { pendingDraftSaves } from "$lib/stores/server-update";
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
	pendingDraftSave,
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

	// Words taken from a message that waited for a server update are in no other
	// place. The restart answers a save with the proxy's page, so a save that fails is
	// tried again, from the persistence and not from the page: the person may have
	// gone Home meanwhile. A chat's words are held by one keeper in this tab, and every
	// later save of that chat takes it over.
	describe("a save that must not be lost to a failed request", () => {
		const draftUrl = (id: string) => `/api/conversations/${id}/draft`;
		// A chat of its own for each test: the keepers are module-level, as the chat page
		// is rebuilt when the person comes back.
		let chat = "";
		let otherChat = "";
		let chatsMade = 0;
		const save = (conversationId: string, draftText: string) => ({
			conversationId,
			draftText,
			selectedAttachmentIds: [],
		});
		const proxyPage = () =>
			new Response("<html><body>Back soon</body></html>", {
				status: 503,
				headers: { "Content-Type": "text/html" },
			});
		const refused = () =>
			new Response(JSON.stringify({ error: "Conversation not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		const ok = () => new Response(null, { status: 200 });
		const puts = (fetchMock: ReturnType<typeof vi.fn>) =>
			fetchMock.mock.calls
				.filter(([, init]) => init?.method === "PUT")
				.map(([input, init]) => [
					input,
					JSON.parse(String(init.body)).draftText,
				]);
		const putTexts = (fetchMock: ReturnType<typeof vi.fn>) =>
			puts(fetchMock).map(([, text]) => text);
		/** A server that is away (the proxy's page) until `backAtMs`, then well. */
		function serverBackAt(backAtMs: number) {
			const start = Date.now();
			return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Date.now() - start < backAtMs ? proxyPage() : ok(),
			);
		}
		/** A server whose saves are answered when the test says so, in the order they were sent. */
		function heldServer() {
			const answers: Array<(response: Response) => void> = [];
			const fetchMock = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					init?.method === "DELETE"
						? Promise.resolve(ok())
						: new Promise<Response>((resolve) => {
								answers.push(resolve);
							}),
			);
			const answer = async (index: number, response: Response) => {
				answers[index](response);
				await vi.advanceTimersByTimeAsync(0);
			};
			return { fetchMock, answer };
		}

		beforeEach(() => {
			vi.useFakeTimers();
			clearConversationSessionState();
			chatsMade += 1;
			chat = `conv-held-${chatsMade}`;
			otherChat = `conv-held-${chatsMade}-other`;
		});
		afterEach(() => {
			clearConversationSessionState();
			vi.useRealTimers();
		});

		it("sends it again every three seconds until it lands, and then stops", async () => {
			const fetchMock = serverBackAt(6000);
			const persistence = createDraftPersistence(fetchMock, 400);

			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);
			expect(puts(fetchMock)).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(2999);
			expect(puts(fetchMock)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(puts(fetchMock)).toHaveLength(2);
			// The server is back at six seconds: the third try lands.
			await vi.advanceTimersByTimeAsync(3000);
			expect(puts(fetchMock)).toEqual([
				[draftUrl(chat), "A question"],
				[draftUrl(chat), "A question"],
				[draftUrl(chat), "A question"],
			]);

			await vi.advanceTimersByTimeAsync(60_000);
			expect(puts(fetchMock)).toHaveLength(3);
		});

		it("saves once, as `persist` does, when the first request lands", async () => {
			const fetchMock = vi.fn(async () => ok());
			const persistence = createDraftPersistence(fetchMock, 400);

			await persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(puts(fetchMock)).toEqual([[draftUrl(chat), "A question"]]);
		});

		it("tries again after a request that never reached the server, too", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new TypeError("Failed to fetch"))
				.mockResolvedValue(ok());
			const persistence = createDraftPersistence(fetchMock, 400);

			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(3000);

			expect(puts(fetchMock)).toHaveLength(2);
		});

		it("does not send an answer that refuses the save again: it never lands", async () => {
			const fetchMock = vi.fn(async () => refused());
			const persistence = createDraftPersistence(fetchMock, 400);

			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(puts(fetchMock)).toHaveLength(1);
		});

		it("goes on after the page that made it is gone: clearing the persistence does not stop it", async () => {
			const fetchMock = serverBackAt(6000);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);

			// What a chat switch does to the persistence, and a page that is left
			// simply stops calling it.
			persistence.clear();
			await persistence.flush();
			await vi.advanceTimersByTimeAsync(9000);

			expect(puts(fetchMock)).toHaveLength(3);
		});

		it("is not stopped by the draft of another chat", async () => {
			const fetchMock = serverBackAt(6000);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);

			void persistence.persist(save(otherChat, "Another chat"), true);
			await persistence.deleteDraft(`${otherChat}-third`);
			await vi.advanceTimersByTimeAsync(9000);

			expect(
				puts(fetchMock).filter(([url]) => url === draftUrl(chat)),
			).toHaveLength(3);
		});

		// What the person types while the server is away is the newest of the chat's
		// words, and the older ones must not be sent again: but it is these newer words
		// that must land, so a save of that chat takes the hold over.
		describe("when a newer save of that chat is made", () => {
			it("holds the newer words the same way: the older are never sent again, the newer land", async () => {
				const fetchMock = serverBackAt(9000);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);

				// The person is back in the chat and types: the save waits out its delay.
				void persistence.persist(save(chat, "Typed since"));
				await vi.advanceTimersByTimeAsync(20_000);

				const texts = putTexts(fetchMock);
				expect(texts[0]).toBe("A question");
				// Never again once the newer words were out; those are tried until the
				// server is back (nine seconds in) and then no more.
				expect(texts.slice(1).every((text) => text === "Typed since")).toBe(
					true,
				);
				expect(texts.slice(1)).toHaveLength(4);
				const server = fetchMock.mock.results.map((result) => result.value);
				expect((await server.at(-1)).status).toBe(200);
				await vi.advanceTimersByTimeAsync(60_000);
				expect(puts(fetchMock)).toHaveLength(texts.length);
			});

			it("does so for a save of another persistence of the tab: the page is rebuilt when the person comes back", async () => {
				const fetchMock = serverBackAt(9000);
				const earlier = createDraftPersistence(fetchMock, 400);
				void earlier.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);

				const later = createDraftPersistence(fetchMock, 400);
				void later.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(20_000);

				// The newer words go at once, without waiting for the pause, and again every
				// three seconds: at 0, 3, 6 and 9 seconds, where the server is back.
				expect(putTexts(fetchMock)).toEqual([
					"A question",
					"Typed since",
					"Typed since",
					"Typed since",
					"Typed since",
				]);
			});

			it("does so for the save a flush sends: the page that is left sends what it was about to", async () => {
				const fetchMock = serverBackAt(7000);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "Restored words"));
				await vi.advanceTimersByTimeAsync(1000);

				// The person adds a character and leaves the chat before the delay is out.
				void persistence.persist(save(chat, "Restored words!"));
				await persistence.flush();
				await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

				const texts = putTexts(fetchMock);
				expect(texts.filter((text) => text === "Restored words")).toHaveLength(
					1,
				);
				expect(texts.at(-1)).toBe("Restored words!");
				expect(pendingDraftSave(chat)).toBeNull();
			});

			it("sends the newer words only when the try that is out has been answered", async () => {
				const { fetchMock, answer } = heldServer();
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);
				expect(puts(fetchMock)).toHaveLength(1);

				void persistence.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(10_000);
				// The older request is still out: it may yet land, and the newer must go after it.
				expect(puts(fetchMock)).toHaveLength(1);

				await answer(0, ok());
				expect(putTexts(fetchMock)).toEqual(["A question", "Typed since"]);
				await answer(1, ok());
				await vi.advanceTimersByTimeAsync(60_000);
				expect(puts(fetchMock)).toHaveLength(2);
			});

			it("goes on to the newer words when the older are refused", async () => {
				const { fetchMock, answer } = heldServer();
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);
				void persistence.persist(save(chat, "Typed since"), true);

				await answer(0, refused());

				expect(putTexts(fetchMock)).toEqual(["A question", "Typed since"]);
			});

			it("sends the first try of a held save behind a save another persistence has out", async () => {
				const { fetchMock, answer } = heldServer();
				const earlier = createDraftPersistence(fetchMock, 400);
				void earlier.persist(save(chat, "Typed"), true);
				await vi.advanceTimersByTimeAsync(0);
				expect(puts(fetchMock)).toHaveLength(1);

				const later = createDraftPersistence(fetchMock, 400);
				void later.persistUntilSaved(save(chat, "Restored words"));
				await vi.advanceTimersByTimeAsync(5000);
				expect(puts(fetchMock)).toHaveLength(1);

				await answer(0, ok());
				expect(putTexts(fetchMock)).toEqual(["Typed", "Restored words"]);
			});

			it("ends the hold when the newer words are refused", async () => {
				const fetchMock = vi
					.fn()
					.mockResolvedValueOnce(proxyPage())
					.mockResolvedValue(refused());
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);

				void persistence.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(60_000);

				expect(putTexts(fetchMock)).toEqual(["A question", "Typed since"]);
				expect(pendingDraftSave(chat)).toBeNull();
			});

			it("lets the caller of the older words go when the newer take them over", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);
				let olderSettled = false;
				void persistence
					.persistUntilSaved(save(chat, "A question"))
					.then(() => {
						olderSettled = true;
					});
				await vi.advanceTimersByTimeAsync(0);
				expect(olderSettled).toBe(false);

				void persistence.persistUntilSaved(save(chat, "Put back again"));
				await vi.advanceTimersByTimeAsync(0);

				expect(olderSettled).toBe(true);
				expect(pendingDraftSave(chat)?.draftText).toBe("Put back again");
			});

			it("lets a plain save wait for no longer than its first try", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);
				let settled = false;

				void persistence.persist(save(chat, "Typed since"), true).then(() => {
					settled = true;
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(settled).toBe(true);
				// ...while the words go on being held.
				expect(pendingDraftSave(chat)?.draftText).toBe("Typed since");
			});
		});

		it("stops when that chat's draft is deleted: a delete wins", async () => {
			const fetchMock = serverBackAt(9000);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);

			await persistence.deleteDraft(chat);
			// The pause between tries is over with it, not left to run out.
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(20_000);

			expect(puts(fetchMock)).toHaveLength(1);
			expect(pendingDraftSave(chat)).toBeNull();
		});

		it("stops when the draft is emptied, which deletes it", async () => {
			const fetchMock = serverBackAt(9000);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);

			await persistence.persist(save(chat, ""));
			await vi.advanceTimersByTimeAsync(20_000);

			expect(puts(fetchMock)).toHaveLength(1);
		});

		it("does not hold words saved after a delete: they are a plain save again", async () => {
			const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));
			await vi.advanceTimersByTimeAsync(0);
			await persistence.deleteDraft(chat);

			await persistence.persist(save(chat, "Typed since"), true);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(putTexts(fetchMock)).toEqual(["A question", "Typed since"]);
		});

		// The eight minutes are an update's: the longest a message waits for one. They
		// count from the first words the chat held, so a person who keeps typing through
		// a long outage does not keep the notice back, or the server asked, for ever.
		describe("the eight minutes an update takes", () => {
			it("gives up after them", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);

				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000 - 1);
				const triedByThen = puts(fetchMock).length;
				expect(triedByThen).toBeGreaterThan(100);

				await vi.advanceTimersByTimeAsync(60_000);
				const tried = puts(fetchMock).length;
				expect(tried).toBeLessThanOrEqual(triedByThen + 1);
				await vi.advanceTimersByTimeAsync(5 * 60_000);
				expect(puts(fetchMock)).toHaveLength(tried);
			});

			it("count from the first words the chat held, not from the save that took over", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(7 * 60 * 1000);

				void persistence.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
				const tried = puts(fetchMock).length;
				await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

				// Held to the eight minutes, not to fifteen.
				expect(puts(fetchMock)).toHaveLength(tried);
				expect(pendingDraftSave(chat)).toBeNull();
			});

			it("start over for words held after the others were given up", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
				const tried = puts(fetchMock).length;

				void persistence.persistUntilSaved(save(chat, "Put back later"));
				await vi.advanceTimersByTimeAsync(10_000);

				expect(puts(fetchMock).length).toBeGreaterThan(tried + 1);
				expect(putTexts(fetchMock).at(-1)).toBe("Put back later");
			});
		});

		it("lets a delete wait for the try that is on its way, as for any save", async () => {
			const answers: Array<() => void> = [];
			const fetchMock = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					init?.method === "DELETE"
						? Promise.resolve(ok())
						: new Promise<Response>((resolve) => {
								answers.push(() => resolve(proxyPage()));
							}),
			);
			const persistence = createDraftPersistence(fetchMock, 400);
			void persistence.persistUntilSaved(save(chat, "A question"));

			void persistence.deleteDraft(chat);
			for (const answer of answers.splice(0)) answer();
			await vi.advanceTimersByTimeAsync(20_000);

			const calls = fetchMock.mock.calls.map(([, init]) => init?.method);
			expect(calls.filter((method) => method === "PUT")).toHaveLength(1);
			expect(calls.filter((method) => method === "DELETE")).toHaveLength(2);
		});

		describe("what a page that opens the chat is told", () => {
			it("is the newest words that have not landed, and nothing once they have", async () => {
				const fetchMock = serverBackAt(4000);
				const persistence = createDraftPersistence(fetchMock, 400);
				expect(pendingDraftSave(chat)).toBeNull();

				void persistence.persistUntilSaved({
					...save(chat, "A question"),
					selectedAttachmentIds: ["file-1"],
				});
				await vi.advanceTimersByTimeAsync(0);
				expect(pendingDraftSave(chat)).toMatchObject({
					conversationId: chat,
					draftText: "A question",
					selectedAttachmentIds: ["file-1"],
				});

				void persistence.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(0);
				expect(pendingDraftSave(chat)?.draftText).toBe("Typed since");
				expect(pendingDraftSave(otherChat)).toBeNull();

				await vi.advanceTimersByTimeAsync(10_000);
				expect(pendingDraftSave(chat)).toBeNull();
			});

			it("is nothing once the session is over", async () => {
				const fetchMock = serverBackAt(Number.POSITIVE_INFINITY);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(chat, "A question"));
				await vi.advanceTimersByTimeAsync(0);

				clearConversationSessionState();
				await vi.advanceTimersByTimeAsync(60_000);

				expect(pendingDraftSave(chat)).toBeNull();
				expect(puts(fetchMock)).toHaveLength(1);
			});
		});

		// The shell holds its Refresh notice while words are on their way: a reload
		// now would lose them.
		describe("the count the shell holds its notice for", () => {
			it("is the chats whose words have not landed, and returns to nothing as they do", async () => {
				const fetchMock = serverBackAt(4000);
				const persistence = createDraftPersistence(fetchMock, 400);
				expect(get(pendingDraftSaves)).toBe(0);

				void persistence.persistUntilSaved(save(chat, "A question"));
				void persistence.persistUntilSaved(save(otherChat, "Another chat"));
				await vi.advanceTimersByTimeAsync(0);
				expect(get(pendingDraftSaves)).toBe(2);

				// A newer save of a chat that is held is the same chat's words.
				void persistence.persist(save(chat, "Typed since"), true);
				await vi.advanceTimersByTimeAsync(0);
				expect(get(pendingDraftSaves)).toBe(2);

				await vi.advanceTimersByTimeAsync(10_000);
				expect(get(pendingDraftSaves)).toBe(0);
			});

			it("goes down with a delete, a refusal and the end of the eight minutes", async () => {
				const fetchMock = vi.fn(
					async (_input: RequestInfo | URL, init?: RequestInit) =>
						init?.method === "DELETE"
							? ok()
							: String(_input).includes("refused")
								? refused()
								: proxyPage(),
				);
				const persistence = createDraftPersistence(fetchMock, 400);
				void persistence.persistUntilSaved(save(`${chat}-deleted`, "Words"));
				void persistence.persistUntilSaved(save(`${chat}-refused`, "Words"));
				void persistence.persistUntilSaved(save(`${chat}-capped`, "Words"));
				await vi.advanceTimersByTimeAsync(0);
				expect(get(pendingDraftSaves)).toBe(2);

				await persistence.deleteDraft(`${chat}-deleted`);
				expect(get(pendingDraftSaves)).toBe(1);

				await vi.advanceTimersByTimeAsync(8 * 60 * 1000 + 3000);
				expect(get(pendingDraftSaves)).toBe(0);
			});
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
