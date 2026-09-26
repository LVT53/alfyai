import { describe, expect, it, vi } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	askAlfyInComment,
	createArtifactComment,
	exportArtifactDocument,
	fetchArtifact,
	fetchArtifactVersionBody,
	fetchArtifactVersions,
	fetchConversationArtifacts,
	resolveArtifactComment,
	restoreArtifactVersion,
	saveArtifactBody,
	saveDocumentTabs,
	toggleDocumentTask,
} from "./artifacts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("artifacts client API", () => {
	it("fetches one artifact's detail, versions and comments, leaving the wire-level ok behind", async () => {
		const detail = {
			artifact: { id: "artifact-1", kind: "document", title: "Weekend" },
			versions: [],
			comments: [],
		};
		// Ruling 49: the route answers { ok: true, artifact, versions, comments }.
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ...detail }));

		const result = await fetchArtifact("artifact-1", undefined, fetchMock);
		expect(result).toEqual(detail);
		expect(result).not.toHaveProperty("ok");
		expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1");
	});

	// The default ownership scope hides an incognito conversation's own
	// artifacts (see ArtifactScopeOptions), so opening one from inside its
	// own chat needs the conversation id widened into scope, the same way
	// `fetchConversationArtifacts` already carries it. The server only
	// widens the scope to a conversation the caller owns, so sending it is
	// always safe for a non-incognito chat too.
	it("carries the current conversation id as a query parameter, so an incognito artifact stays in scope", async () => {
		const payload = {
			artifact: { id: "artifact-1", kind: "document", title: "Weekend" },
			versions: [],
			comments: [],
		};
		const fetchMock = vi.fn(async () => jsonResponse(payload));

		await fetchArtifact("artifact-1", "conv 1/2", fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts/artifact-1?conversationId=conv%201%2F2",
		);
	});

	it("omits the query parameter entirely when no conversation id is given", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ artifact: {}, versions: [], comments: [] }),
		);

		await fetchArtifact("artifact-1", null, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1");
	});

	it("throws on a failed response, surfacing the family's 404 status", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "not_found" }, 404),
		);

		// The panel maps ANY caught error to its own artifacts.error.load
		// copy rather than trusting the message text (readErrorPayload has no
		// special case for the family's `reason` field, and does not need
		// one): this proves the request rejects with the right status, which
		// is what a caller actually branches on.
		await expect(
			fetchArtifact("missing", undefined, fetchMock),
		).rejects.toMatchObject({
			status: 404,
		});
	});

	it("falls back to the caller's message on an empty error body", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

		await expect(
			fetchArtifact("artifact-1", undefined, fetchMock),
		).rejects.toThrow("Failed to open this item");
	});

	it("fetches a conversation's artifacts, unwrapping the list", async () => {
		const artifacts = [
			{ id: "artifact-2", kind: "document", title: "Newer" },
			{ id: "artifact-1", kind: "file", title: "Older" },
		];
		// Ruling 49: the route answers { ok: true, artifacts }; _unwrapList reads
		// only the `artifacts` key, so the sibling `ok` is simply ignored.
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, artifacts }));

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual(artifacts);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts?conversationId=conv-1",
		);
	});

	it("returns an empty list rather than throwing when the field is missing", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual([]);
	});

	describe("versions (Slice 1, T6)", () => {
		it("fetches the version list, newest first as the server sends them", async () => {
			const versions = [
				{
					id: "v2",
					versionNumber: 2,
					author: "user",
					summary: "Edit",
					createdAt: 2,
				},
				{
					id: "v1",
					versionNumber: 1,
					author: "alfy",
					summary: "First draft",
					createdAt: 1,
				},
			];
			const fetchMock = vi.fn(async () => jsonResponse({ ok: true, versions }));

			await expect(
				fetchArtifactVersions("artifact-1", "conv-1", fetchMock),
			).resolves.toEqual(versions);
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/artifacts/artifact-1/versions?conversationId=conv-1",
			);
		});

		it("fetches one version's stored body", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: true, body: "# Weekend\n\nOld text." }),
			);

			await expect(
				fetchArtifactVersionBody("artifact-1", "version-1", null, fetchMock),
			).resolves.toBe("# Weekend\n\nOld text.");
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/artifacts/artifact-1/versions/version-1",
			);
		});

		it("restores a version and returns its version number", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: true, version: 4 }),
			);

			await expect(
				restoreArtifactVersion("artifact-1", "version-1", "conv-1", fetchMock),
			).resolves.toBe(4);
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/artifacts/artifact-1/versions/version-1/restore?conversationId=conv-1",
				expect.objectContaining({ method: "POST" }),
			);
		});

		it("throws on a failed restore", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: false, reason: "no_body" }, 400),
			);

			await expect(
				restoreArtifactVersion("artifact-1", "version-1", null, fetchMock),
			).rejects.toThrow();
		});
	});

	describe("saveArtifactBody (Slice 1, T7)", () => {
		it("PATCHes the body route and returns the new version on success", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: true, version: 3 }),
			);

			const result = await saveArtifactBody(
				"artifact-1",
				"New text.",
				2,
				"conv-1",
				fetchMock,
			);

			expect(result).toEqual({ ok: true, version: 3 });
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/artifacts/artifact-1/body?conversationId=conv-1",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ body: "New text.", expectVersion: 2 }),
				}),
			);
		});

		it("never throws on a documented refusal — the caller decides what it means", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: false, reason: "version_conflict" }, 409),
			);

			await expect(
				saveArtifactBody("artifact-1", "New text.", 2, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "version_conflict" });
		});

		it("omits expectVersion from the body when not given", async () => {
			const fetchMock = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					jsonResponse({ ok: true, version: 1 }),
			);

			await saveArtifactBody("artifact-1", "Text.", undefined, null, fetchMock);

			const call = fetchMock.mock.calls[0]?.[1];
			expect(JSON.parse(String(call?.body))).toEqual({ body: "Text." });
		});
	});

	describe("saveDocumentTabs (Slice 1, T9)", () => {
		it("PATCHes the SAME body route with a tabs field and the current markdown", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: true, version: 5 }),
			);
			const tabs = [
				{ id: "t1", title: "Plan", startBlockId: "p1" },
				{ id: "t2", title: "Budget", startBlockId: "p2" },
			];

			const result = await saveDocumentTabs(
				"artifact-1",
				tabs,
				"Current text.",
				4,
				"conv-1",
				fetchMock,
			);

			expect(result).toEqual({ ok: true, version: 5 });
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/artifacts/artifact-1/body?conversationId=conv-1",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({
						body: "Current text.",
						tabs,
						expectVersion: 4,
					}),
				}),
			);
		});

		it("never throws on a documented refusal, matching saveArtifactBody's own contract", async () => {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: false, reason: "too_large" }, 413),
			);

			await expect(
				saveDocumentTabs("artifact-1", [], "Text.", undefined, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "too_large" });
		});
	});

	describe("toggleDocumentTask (T9.7 — the chat card's tick, through the SAME patch path)", () => {
		function taskDetail(overrides: Record<string, unknown> = {}) {
			const body = serializeDocument(parseDocument("- [ ] Charger").blocks);
			const blockId = parseDocument(body, { mint: false }).blocks[0].id;
			return {
				body,
				blockId,
				artifact: {
					id: "doc-1",
					kind: "document",
					title: "Packing",
					body,
					versionNumber: 3,
					...overrides,
				},
			};
		}

		it("fetches the current body, toggles it through applyPatchSet, and saves through the body route", async () => {
			const { blockId, artifact } = taskDetail();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({ ok: true, artifact, versions: [], comments: [] }),
				)
				.mockResolvedValueOnce(jsonResponse({ ok: true, version: 4 }));

			const result = await toggleDocumentTask(
				"doc-1",
				blockId,
				true,
				"conv-1",
				fetchMock,
			);

			expect(result).toEqual({ ok: true, version: 4 });
			expect(fetchMock).toHaveBeenNthCalledWith(
				1,
				"/api/artifacts/doc-1?conversationId=conv-1",
			);
			const saveCall = fetchMock.mock.calls[1];
			expect(saveCall[0]).toBe(
				"/api/artifacts/doc-1/body?conversationId=conv-1",
			);
			const savedPayload = JSON.parse(String(saveCall[1].body));
			expect(savedPayload.expectVersion).toBe(3);
			// The SAME canonical form the parser/serializer produce for a
			// checked task — never a hand-rolled string replace.
			expect(savedPayload.body).toBe(
				serializeDocument(
					parseDocument(`<!--b:${blockId}-->\n- [x] Charger`, {
						mint: false,
					}).blocks,
				),
			);
		});

		it("is block_not_found (and never calls save) when the block no longer exists", async () => {
			const fetchMock = vi.fn().mockResolvedValueOnce(
				jsonResponse({
					ok: true,
					artifact: {
						id: "doc-1",
						kind: "document",
						title: "Packing",
						body: "Nothing here.",
						versionNumber: 1,
					},
					versions: [],
					comments: [],
				}),
			);

			const result = await toggleDocumentTask(
				"doc-1",
				"missing-block",
				true,
				null,
				fetchMock,
			);

			expect(result).toEqual({ ok: false, reason: "block_not_found" });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("is not_found when the artifact itself cannot be read", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({ ok: false, reason: "not_found" }, 404),
				);

			const result = await toggleDocumentTask(
				"doc-1",
				"b1",
				true,
				null,
				fetchMock,
			);

			expect(result).toEqual({ ok: false, reason: "not_found" });
		});

		it("passes through the body route's own refusal (e.g. a version conflict)", async () => {
			const { blockId, artifact } = taskDetail();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({ ok: true, artifact, versions: [], comments: [] }),
				)
				.mockResolvedValueOnce(
					jsonResponse({ ok: false, reason: "version_conflict" }, 409),
				);

			const result = await toggleDocumentTask(
				"doc-1",
				blockId,
				true,
				null,
				fetchMock,
			);

			expect(result).toEqual({ ok: false, reason: "version_conflict" });
		});
	});
});

const TEXT_ANCHOR = {
	kind: "text" as const,
	blockId: "p1",
	quote: "flight",
	prefix: "Book the ",
	suffix: ".",
};

describe("createArtifactComment", () => {
	it("posts the anchor and body, and returns the created comment", async () => {
		const comment = {
			id: "comment-1",
			artifactId: "artifact-1",
			parentId: null,
			anchor: TEXT_ANCHOR,
			author: "user",
			body: "Too early?",
			status: "open",
			createdAt: 1,
			replies: [],
		};
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, comment }));

		const result = await createArtifactComment(
			"artifact-1",
			TEXT_ANCHOR,
			"Too early?",
			undefined,
			null,
			fetchMock,
		);

		expect(result).toEqual(comment);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/artifacts/artifact-1/comments");
		expect(JSON.parse(String(init.body))).toEqual({
			anchor: TEXT_ANCHOR,
			body: "Too early?",
		});
	});

	it("carries parentId for a reply, and the conversation id in the query", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				comment: {
					id: "comment-2",
					artifactId: "artifact-1",
					parentId: "comment-1",
					anchor: null,
					author: "user",
					body: "Moved it to ten.",
					status: "open",
					createdAt: 2,
					replies: [],
				},
			}),
		);

		await createArtifactComment(
			"artifact-1",
			null,
			"Moved it to ten.",
			"comment-1",
			"conv 1/2",
			fetchMock,
		);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"/api/artifacts/artifact-1/comments?conversationId=conv%201%2F2",
		);
		expect(JSON.parse(String(init.body))).toEqual({
			anchor: null,
			body: "Moved it to ten.",
			parentId: "comment-1",
		});
	});

	it("throws (via requestJson) on a refused comment, never swallowing the failure", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "invalid_request" }, 400),
		);

		await expect(
			createArtifactComment(
				"artifact-1",
				TEXT_ANCHOR,
				"",
				undefined,
				null,
				fetchMock,
			),
		).rejects.toThrow();
	});
});

describe("resolveArtifactComment", () => {
	it("posts { resolved } to the comment's own resolve route", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));

		await resolveArtifactComment(
			"artifact-1",
			"comment-1",
			true,
			null,
			fetchMock,
		);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/artifacts/artifact-1/comments/comment-1/resolve");
		expect(JSON.parse(String(init.body))).toEqual({ resolved: true });
	});
});

describe("askAlfyInComment", () => {
	it("posts to the alfy route and returns the outcome shape untouched by ok", async () => {
		const reply = {
			id: "comment-2",
			artifactId: "artifact-1",
			parentId: "comment-1",
			anchor: null,
			author: "alfy",
			body: "Changed it.",
			status: "open",
			createdAt: 2,
			replies: [],
		};
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				outcome: "applied",
				applied: 1,
				refused: 0,
				version: 3,
				reply,
			}),
		);

		const result = await askAlfyInComment(
			"artifact-1",
			"comment-1",
			"conv-1",
			fetchMock,
		);

		expect(result).toEqual({
			outcome: "applied",
			applied: 1,
			refused: 0,
			version: 3,
			reply,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts/artifact-1/comments/comment-1/alfy?conversationId=conv-1",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("throws on a 404/504 rather than returning a fake outcome", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "not_found" }, 404),
		);

		await expect(
			askAlfyInComment("artifact-1", "comment-1", null, fetchMock),
		).rejects.toThrow();
	});
});

describe("exportArtifactDocument", () => {
	it("posts the format and returns the created job, never throwing on success", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: true, job: { id: "job-1" } }),
		);

		const result = await exportArtifactDocument(
			"artifact-1",
			"pdf",
			"conv-1",
			fetchMock,
		);

		expect(result).toEqual({ ok: true, job: { id: "job-1" } });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/artifacts/artifact-1/export?conversationId=conv-1");
		expect(JSON.parse(String(init.body))).toEqual({ format: "pdf" });
	});

	// Mirrors saveArtifactBody (T7.3/T7.10): a documented refusal is a normal
	// return value, never a thrown ApiError, so the sheet can react to it.
	it("never throws on a documented refusal — returns { ok: false, reason }", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "source_too_large" }, 422),
		);

		await expect(
			exportArtifactDocument("artifact-1", "pdf", null, fetchMock),
		).resolves.toEqual({ ok: false, reason: "source_too_large" });
	});

	it("answers not_found rather than throwing when the response has no JSON body at all", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

		await expect(
			exportArtifactDocument("artifact-1", "markdown", null, fetchMock),
		).resolves.toEqual({ ok: false, reason: "not_found" });
	});
});
