import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversationExists,
	createConversationFork,
	deleteConversationMessages,
	fetchConversationDetail,
	fetchConversationMarkdownExport,
	keepMessageAsDocument,
	persistConversationLinkedSources,
	runConversationBatch,
	savePinnedConversationSidebarOrder,
	setConversationSidebarPinned,
	updateInstructionSuggestionStatus,
} from "./conversations";
import type { ApiError } from "./http";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("conversationExists", () => {
	it("returns true when the conversation detail endpoint succeeds", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1");
	});

	it("returns false when the conversation detail endpoint returns 404", async () => {
		const fetchMock = vi.fn(
			async () => new Response("Not found", { status: 404 }),
		);

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBe(false);
	});

	it("returns null on transient failures", async () => {
		const fetchMock = vi.fn(
			async () => new Response("Server error", { status: 500 }),
		);

		await expect(conversationExists("conv-1", fetchMock)).resolves.toBeNull();
	});
});

describe("keepMessageAsDocument", () => {
	it("posts to the message's document route and returns the artifact summary", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						artifactId: "artifact-1",
						title: "Vienna trip",
						created: true,
					}),
					{ status: 200 },
				),
		);

		const result = await keepMessageAsDocument(
			"conv-1",
			"message-1",
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/messages/message-1/document",
			expect.objectContaining({ method: "POST" }),
		);
		expect(result).toEqual({
			artifactId: "artifact-1",
			title: "Vienna trip",
			created: true,
		});
	});

	it("throws when the message cannot be kept as a document", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: false, reason: "not_found" }), {
					status: 404,
				}),
		);

		await expect(
			keepMessageAsDocument("conv-1", "message-1", fetchMock),
		).rejects.toThrow();
	});
});

describe("fetchConversationDetail", () => {
	it("requests the bootstrap view through the conversation detail endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversation: {
							id: "conv-1",
							title: "Bootstrap",
							projectId: null,
							createdAt: 1,
							updatedAt: 1,
						},
						messages: [],
						bootstrap: true,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const detail = await fetchConversationDetail("conv-1", {
			view: "bootstrap",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1?view=bootstrap",
		);
		expect(detail.bootstrap).toBe(true);
	});
});

describe("deleteConversationMessages", () => {
	it("sends explicit forked source-history confirmation when provided", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ deleted: 2 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(
			deleteConversationMessages("conv-1", ["user-1", "assistant-1"], {
				confirmForkedSourceHistoryMutation: true,
				fetchImpl: fetchMock,
			}),
		).resolves.toBe(2);

		const request = (
			fetchMock.mock.calls[0] as unknown as [unknown, RequestInit?] | undefined
		)?.[1];
		expect(request?.body).toBe(
			JSON.stringify({
				messageIds: ["user-1", "assistant-1"],
				confirmForkedSourceHistoryMutation: true,
			}),
		);
	});
});

describe("createConversationFork", () => {
	it("posts the selected assistant response and returns the fork payload", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversation: {
							id: "fork-conv",
							title: "Source title (fork 1)",
							projectId: "project-1",
							createdAt: 1,
							updatedAt: 1,
						},
						forkOrigin: {
							forkConversationId: "fork-conv",
							sourceConversationId: "source-conv",
							sourceAssistantMessageId: "assistant-1",
							sourceConversationIdAvailable: true,
							sourceAssistantMessageIdAvailable: true,
							copiedForkPointMessageId: "fork-assistant-1",
							sourceTitle: "Source title",
							forkSequence: 1,
							createdAt: 1,
						},
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				),
		);

		const result = await createConversationFork(
			"source-conv",
			{ messageId: "assistant-1" },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/source-conv/forks",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ messageId: "assistant-1" }),
			},
		);
		expect(result.conversation.id).toBe("fork-conv");
		expect(result.forkOrigin.copiedForkPointMessageId).toBe("fork-assistant-1");
	});

	it("preserves precise server fork failure codes for localization", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error:
							"Forks can only be created from a persisted assistant response",
						code: "invalid_source_message",
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		);

		await expect(
			createConversationFork("source-conv", { messageId: "user-1" }, fetchMock),
		).rejects.toMatchObject({
			name: "ApiError",
			message: "Forks can only be created from a persisted assistant response",
			status: 400,
			code: "invalid_source_message",
		} satisfies Partial<ApiError>);
	});
});

describe("conversation sidebar API", () => {
	it("patches conversation pin state through the conversation detail endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "conv-1",
						title: "Pinned",
						projectId: null,
						sidebarPinned: true,
						sidebarSortOrder: 0,
						createdAt: 1,
						updatedAt: 1,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await setConversationSidebarPinned(
			"conv-1",
			true,
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sidebarPinned: true }),
		});
		expect(result.sidebarPinned).toBe(true);
		expect(result.sidebarSortOrder).toBe(0);
	});

	it("saves pinned conversation order through the sidebar-order endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						conversations: [
							{
								id: "conv-2",
								title: "Pinned",
								projectId: null,
								sidebarPinned: true,
								sidebarSortOrder: 0,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await savePinnedConversationSidebarOrder(
			["conv-2", "conv-1"],
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/conversations/sidebar-order", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ orderedIds: ["conv-2", "conv-1"] }),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("conv-2");
	});
});

describe("runConversationBatch", () => {
	function conversationIds(count: number): string[] {
		return Array.from({ length: count }, (_, index) => `conv-${index + 1}`);
	}

	function jsonOk(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	function sentBody(init: RequestInit | undefined): {
		action: string;
		ids: string[];
		projectId?: string | null;
		pinned?: boolean;
	} {
		return JSON.parse(String(init?.body));
	}

	it("sends a large batch in chunks of 50, in order", async () => {
		const ids = conversationIds(120);
		let inFlight = 0;
		let mostInFlight = 0;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				inFlight += 1;
				mostInFlight = Math.max(mostInFlight, inFlight);
				// Give a request sent beside this one the time to show itself.
				await new Promise((resolve) => setTimeout(resolve, 1));
				inFlight -= 1;
				return jsonOk({
					results: sentBody(init).ids.map((id) => ({ id, ok: true })),
				});
			},
		);

		const results = await runConversationBatch(
			{ action: "move", ids, projectId: "proj-1" },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		for (const call of fetchMock.mock.calls) {
			expect(call[0]).toBe("/api/conversations/batch");
			expect(call[1]).toMatchObject({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
		}
		const bodies = fetchMock.mock.calls.map(([, init]) => sentBody(init));
		expect(bodies.map((body) => body.ids.length)).toEqual([50, 50, 20]);
		expect(bodies.map((body) => body.ids)).toEqual([
			ids.slice(0, 50),
			ids.slice(50, 100),
			ids.slice(100),
		]);
		// Every chunk carries the same action and the same project.
		for (const body of bodies) {
			expect(body).toMatchObject({ action: "move", projectId: "proj-1" });
		}
		expect(results.map((result) => result.id)).toEqual(ids);
		expect(results.every((result) => result.ok)).toBe(true);
		// One after another, never beside each other.
		expect(mostInFlight).toBe(1);
	});

	// The sizes in the order the requests are sent: a pin sends its last chunk
	// first, so the odd one out of 51 ids goes before the full chunk.
	it.each([
		[50, [50]],
		[51, [1, 50]],
		[1, [1]],
	])("splits %i ids into chunks of %j", async (count, chunkSizes) => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				jsonOk({
					results: sentBody(init).ids.map((id) => ({ id, ok: true })),
				}),
		);

		await runConversationBatch(
			{ action: "pin", ids: conversationIds(count), pinned: true },
			fetchMock,
		);

		expect(
			fetchMock.mock.calls.map(([, init]) => sentBody(init).ids.length),
		).toEqual(chunkSizes);
		for (const [, init] of fetchMock.mock.calls) {
			expect(sentBody(init)).toMatchObject({ action: "pin", pinned: true });
		}
	});

	describe("a pin of more than one chunk", () => {
		function answerEveryId() {
			return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				jsonOk({
					results: sentBody(init).ids.map((id) => ({ id, ok: true })),
				}),
			);
		}

		it("sends the chunks last first and still answers in id order", async () => {
			const ids = conversationIds(60);
			const fetchMock = answerEveryId();

			const results = await runConversationBatch(
				{ action: "pin", ids, pinned: true },
				fetchMock,
			);

			const bodies = fetchMock.mock.calls.map(([, init]) => sentBody(init));
			expect(bodies.map((body) => body.ids)).toEqual([
				ids.slice(50),
				ids.slice(0, 50),
			]);
			for (const body of bodies) {
				expect(body).toMatchObject({ action: "pin", pinned: true });
			}
			expect(results.map((result) => result.id)).toEqual(ids);
			expect(results.every((result) => result.ok)).toBe(true);
		});

		it("leaves the first chat on top of Pinned and the rest in the order given", async () => {
			// The server puts each request's chats on top of what is already pinned,
			// its first id highest (it pins them walking backwards). Replayed here,
			// so the order the person sees is what is asserted, not the call order.
			const pinned: string[] = [];
			const fetchMock = vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					const { ids: sent } = sentBody(init);
					pinned.unshift(...sent);
					return jsonOk({ results: sent.map((id) => ({ id, ok: true })) });
				},
			);
			const ids = conversationIds(60);

			await runConversationBatch(
				{ action: "pin", ids, pinned: true },
				fetchMock,
			);

			expect(pinned).toEqual(ids);
		});

		it("keeps an unpin first to last", async () => {
			const ids = conversationIds(60);
			const fetchMock = answerEveryId();

			const results = await runConversationBatch(
				{ action: "pin", ids, pinned: false },
				fetchMock,
			);

			expect(
				fetchMock.mock.calls.map(([, init]) => sentBody(init).ids),
			).toEqual([ids.slice(0, 50), ids.slice(50)]);
			expect(results.map((result) => result.id)).toEqual(ids);
		});

		it("keeps a delete first to last", async () => {
			const ids = conversationIds(60);
			const fetchMock = answerEveryId();

			const results = await runConversationBatch(
				{ action: "delete", ids },
				fetchMock,
			);

			expect(
				fetchMock.mock.calls.map(([, init]) => sentBody(init).ids),
			).toEqual([ids.slice(0, 50), ids.slice(50)]);
			expect(results.map((result) => result.id)).toEqual(ids);
		});

		it("answers in id order when the last chunk fails and the first is answered", async () => {
			// The chunks run last first, so the failed one is sent first: the answer
			// still lines up with the ids, not with the order the requests ran in.
			const ids = conversationIds(60);
			let call = 0;
			const fetchMock = vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					call += 1;
					if (call === 1) throw new TypeError("Failed to fetch");
					return jsonOk({
						results: sentBody(init).ids.map((id) => ({ id, ok: true })),
					});
				},
			);

			const results = await runConversationBatch(
				{ action: "pin", ids, pinned: true },
				fetchMock,
			);

			expect(results.map((result) => result.id)).toEqual(ids);
			expect(
				results.map((result) => (result.ok ? "ok" : result.error)),
			).toEqual([...Array(50).fill("ok"), ...Array(10).fill("unknown")]);
		});
	});

	it("marks a failed chunk unknown and still sends the rest", async () => {
		const ids = conversationIds(120);
		let call = 0;
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				call += 1;
				if (call === 2) throw new TypeError("Failed to fetch");
				return jsonOk({
					results: sentBody(init).ids.map((id) => ({
						id,
						ok: false,
						error: "not_found",
					})),
				});
			},
		);

		const results = await runConversationBatch(
			{ action: "delete", ids },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(results.map((result) => result.id)).toEqual(ids);
		const outcome = (index: number) => {
			const result = results[index];
			return result.ok ? "ok" : result.error;
		};
		// 1 to 50 and 101 to 120 are what the server said; 51 to 100 are not known.
		expect(ids.map((_, index) => outcome(index))).toEqual([
			...Array(50).fill("not_found"),
			...Array(50).fill("unknown"),
			...Array(20).fill("not_found"),
		]);
	});

	it("marks every id of a chunk unknown when the server refuses the request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: "Failed to apply batch action" }),
					{
						status: 500,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const results = await runConversationBatch(
			{ action: "delete", ids: ["conv-1", "conv-2"] },
			fetchMock,
		);

		expect(results).toEqual([
			{ id: "conv-1", ok: false, error: "unknown" },
			{ id: "conv-2", ok: false, error: "unknown" },
		]);
	});

	it("marks an id that a successful answer leaves out unknown", async () => {
		const conversation = {
			id: "conv-1",
			title: "Pinned",
			projectId: null,
			sidebarPinned: true,
			sidebarSortOrder: -1,
			createdAt: 1,
			updatedAt: 1,
		};
		const fetchMock = vi.fn(async () =>
			jsonOk({
				results: [
					{ id: "conv-1", ok: true, conversation },
					{ id: "conv-3", ok: false, error: "failed" },
					{ id: "conv-4", ok: false, error: "not_found" },
				],
			}),
		);

		const results = await runConversationBatch(
			{
				action: "pin",
				ids: ["conv-1", "conv-2", "conv-3", "conv-4"],
				pinned: true,
			},
			fetchMock,
		);

		// In the order the ids were sent, whatever order the server answered in.
		expect(results).toEqual([
			{ id: "conv-1", ok: true, conversation },
			{ id: "conv-2", ok: false, error: "unknown" },
			{ id: "conv-3", ok: false, error: "failed" },
			{ id: "conv-4", ok: false, error: "not_found" },
		]);
	});

	it("does not trust an answer row it cannot read", async () => {
		const fetchMock = vi.fn(async () =>
			jsonOk({
				results: [
					{ id: "conv-1", ok: "yes" },
					{ ok: true },
					null,
					{ id: "conv-3", ok: false, error: "exploded" },
					{ id: "conv-4", ok: true },
				],
			}),
		);

		const results = await runConversationBatch(
			{
				action: "delete",
				ids: ["conv-1", "conv-2", "conv-3", "conv-4"],
			},
			fetchMock,
		);

		expect(results).toEqual([
			{ id: "conv-1", ok: false, error: "unknown" },
			{ id: "conv-2", ok: false, error: "unknown" },
			{ id: "conv-3", ok: false, error: "unknown" },
			{ id: "conv-4", ok: true },
		]);
	});

	it("marks every id unknown when the answer has no results", async () => {
		const fetchMock = vi.fn(async () => jsonOk({ results: "nope" }));

		const results = await runConversationBatch(
			{ action: "delete", ids: ["conv-1"] },
			fetchMock,
		);

		expect(results).toEqual([{ id: "conv-1", ok: false, error: "unknown" }]);
	});

	it("sends nothing for no ids", async () => {
		const fetchMock = vi.fn();

		const results = await runConversationBatch(
			{ action: "delete", ids: [] },
			fetchMock,
		);

		expect(results).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("linked-source persistence API", () => {
	const linkedSource = {
		displayArtifactId: "artifact-1",
		promptArtifactId: "prompt-1",
		familyArtifactIds: ["artifact-1"],
		name: "Doc 1",
		type: "document" as const,
		mimeType: "text/plain",
	};

	it("persists linked sources with attachment ids", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						linkedSources: [linkedSource],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await persistConversationLinkedSources(
			"conversation-1",
			{
				linkedSources: [linkedSource],
				attachmentIds: ["attachment-1", "attachment-2"],
			},
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conversation-1/linked-sources",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					linkedSources: [linkedSource],
					attachmentIds: ["attachment-1", "attachment-2"],
				}),
			},
		);
		expect(result).toEqual([linkedSource]);
	});
});

describe("fetchConversationMarkdownExport", () => {
	// The server sends both Content-Disposition filename forms; the RFC 5987
	// one is the only one that survives a Hungarian conversation title.
	it("prefers the RFC 5987 filename over the ASCII fallback", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("# Árvíztűrő tükörfúrógép", {
					status: 200,
					headers: {
						"Content-Disposition": `attachment; filename="Arvizturo-tukorfurogep.md"; filename*=UTF-8''${encodeURIComponent("Árvíztűrő-tükörfúrógép.md")}`,
					},
				}),
		);

		await expect(
			fetchConversationMarkdownExport("conv-1", fetchMock),
		).resolves.toMatchObject({
			filename: "Árvíztűrő-tükörfúrógép.md",
		});
	});

	it("falls back to the ASCII filename when no RFC 5987 form is sent", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("# Notes", {
					status: 200,
					headers: {
						"Content-Disposition": 'attachment; filename="Notes.md"',
					},
				}),
		);

		await expect(
			fetchConversationMarkdownExport("conv-1", fetchMock),
		).resolves.toMatchObject({ filename: "Notes.md" });
	});
});

describe("updateInstructionSuggestionStatus", () => {
	it("answers one suggestion on the conversation's own route", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						suggestion: {
							id: "suggestion-1",
							status: "dismissed",
							text: "Only suggest trains, no flights.",
							scope: { kind: "personal" },
							createdAt: 1_770_000_000_000,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			updateInstructionSuggestionStatus(
				"conv-1",
				{
					messageId: "msg-1",
					suggestionId: "suggestion-1",
					status: "dismissed",
				},
				fetchMock,
			),
		).resolves.toMatchObject({ id: "suggestion-1", status: "dismissed" });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/instruction-suggestions",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					messageId: "msg-1",
					suggestionId: "suggestion-1",
					status: "dismissed",
				}),
			}),
		);
	});

	it("throws the server's message when the answer is refused", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error:
							"Instruction suggestion was dismissed and cannot be reviewed.",
						errorKey: "instruction_suggestion_transition_conflict",
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			updateInstructionSuggestionStatus(
				"conv-1",
				{
					messageId: "msg-1",
					suggestionId: "suggestion-1",
					status: "reviewed",
				},
				fetchMock,
			),
		).rejects.toThrow(/cannot be reviewed/);
	});
});
