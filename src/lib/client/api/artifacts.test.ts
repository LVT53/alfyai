import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	type ArtifactChange,
	askAlfyInComment,
	createArtifactComment,
	deleteArtifact,
	downloadAppAsHtml,
	exportArtifactDocument,
	fetchArtifact,
	fetchArtifactVersionBody,
	fetchArtifactVersions,
	fetchConversationArtifacts,
	readAppValue,
	regenerateApp,
	regenerateDeletedArtifact,
	resolveArtifactComment,
	restoreArtifactVersion,
	saveArtifactBody,
	saveDocumentTabs,
	subscribeArtifactChanges,
	toggleDocumentTask,
	writeAppValue,
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

	describe("readAppValue / writeAppValue", () => {
		it("reads the parsed body on a NON-2xx status instead of throwing, so the reason survives", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "not_found" }, 404),
			);

			await expect(
				readAppValue("app-1", "k", undefined, fetchMock),
			).resolves.toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?key=k",
			);
		});

		it("posts { key, value } for a write and reads the reason on a refusal", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "too_large" }, 413),
			);

			await expect(
				writeAppValue("app-1", "k", { a: 1 }, undefined, fetchMock),
			).resolves.toEqual({ ok: false, reason: "too_large" });

			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				key: "k",
				value: { a: 1 },
			});
		});

		it("appends conversationId to the read URL when given one, to widen scope for an incognito conversation's own App", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true, value: 1 }),
			);

			await readAppValue("app-1", "k", "conv-1", fetchMock);

			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?key=k&conversationId=conv-1",
			);
		});

		it("appends conversationId to the write URL when given one, and leaves the body as { key, value }", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true }),
			);

			await writeAppValue("app-1", "k", { a: 1 }, "conv-1", fetchMock);

			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?conversationId=conv-1",
			);
			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				key: "k",
				value: { a: 1 },
			});
		});

		// RV-2A. postMessage's structured clone carries a BigInt and a cycle
		// into the parent intact; JSON cannot encode either. The contract
		// promises such a set is refused as not_serialisable (the frame's own
		// localised "cannot be saved" line), not left to time out.
		it("refuses a BigInt or a cyclic value as not_serialisable, without a request", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true }),
			);
			const cyclic: Record<string, unknown> = { name: "loop" };
			cyclic.self = cyclic;

			await expect(
				writeAppValue("app-1", "k", 10n, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "not_serialisable" });
			await expect(
				writeAppValue("app-1", "k", cyclic, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "not_serialisable" });
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("regenerateApp", () => {
		it("posts prompt and expectVersion, and returns the parsed body on success", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({
					ok: true,
					version: 2,
					title: "Split",
					verification: { checked: false },
				}),
			);

			const result = await regenerateApp(
				"app-1",
				"add a currency switch",
				1,
				null,
				fetchMock,
			);

			expect(result).toEqual({
				ok: true,
				version: 2,
				title: "Split",
				verification: { checked: false },
			});
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("/api/artifacts/app-1/app/regenerate");
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				prompt: "add a currency switch",
				expectVersion: 1,
				conversationId: null,
			});
		});

		// RV-2A (ruling 51): the regenerate route widens its scope from the
		// body's conversationId, exactly as the download route does.
		it("sends the panel's conversationId in the body, so an incognito conversation's own App resolves", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({
					ok: true,
					version: 2,
					title: "Split",
					verification: { checked: false },
				}),
			);

			await regenerateApp(
				"app-1",
				"add a currency switch",
				1,
				"conv-incognito",
				fetchMock,
			);

			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				prompt: "add a currency switch",
				expectVersion: 1,
				conversationId: "conv-incognito",
			});
		});

		it("a 409 keeps returning the version, so the caller can offer to retry with the same prompt", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse(
					{ ok: false, reason: "version_conflict", version: 4 },
					409,
				),
			);

			await expect(
				regenerateApp("app-1", "add a currency switch", 1, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "version_conflict", version: 4 });
		});
	});

	describe("downloadAppAsHtml", () => {
		it("posts only the conversation id — never an html field the client could have composed", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true, job: { id: "job-1" }, reused: false }, 202),
			);

			const result = await downloadAppAsHtml("app-1", "conv-1", fetchMock);

			expect(result).toEqual({ ok: true, job: { id: "job-1" }, reused: false });
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("/api/artifacts/app-1/app/download");
			const body = JSON.parse((init as RequestInit).body as string);
			expect(Object.keys(body)).toEqual(["conversationId"]);
			expect(body.conversationId).toBe("conv-1");
		});

		it("reads the refusal reason for a project-linked App with no conversation", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "conversation_required" }, 422),
			);

			await expect(
				downloadAppAsHtml("app-1", null, fetchMock),
			).resolves.toEqual({
				ok: false,
				reason: "conversation_required",
			});
		});
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

// Wave 2.5 polish G1-B: one version number everywhere. Every response that
// carries an artifact's current version is announced to whoever subscribed
// (the chat page), so no surface has to keep its own stale copy. Polish G2-A
// adds the time of the change to the same announcement, and a deletion to the
// same channel.
describe("version announcements", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function listen() {
		const heard: Array<[string, number]> = [];
		const changes: ArtifactChange[] = [];
		const unsubscribe = subscribeArtifactChanges((change) => {
			changes.push(change);
			if (change.type === "version") {
				heard.push([change.artifactId, change.version]);
			}
		});
		return { heard, changes, unsubscribe };
	}

	it("carries the artifact's own updatedAt when a fetch reports it", async () => {
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				artifact: { id: "artifact-1", versionNumber: 7, updatedAt: 1234 },
				versions: [],
				comments: [],
			}),
		);
		await fetchArtifact("artifact-1", null, fetchMock);
		unsubscribe();
		expect(changes).toEqual([
			{
				type: "version",
				artifactId: "artifact-1",
				version: 7,
				updatedAt: 1234,
			},
		]);
	});

	it("stamps a successful write with the moment it was acknowledged", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, version: 4 }));
		await saveArtifactBody("artifact-1", "Text.", 3, null, fetchMock);
		await restoreArtifactVersion("artifact-1", "version-1", null, fetchMock);
		unsubscribe();
		const stamp = new Date("2026-09-29T10:00:00.000Z").getTime();
		expect(changes).toEqual([
			{
				type: "version",
				artifactId: "artifact-1",
				version: 4,
				updatedAt: stamp,
			},
			{
				type: "version",
				artifactId: "artifact-1",
				version: 4,
				updatedAt: stamp,
			},
		]);
	});

	it("says nothing about time for a version list, whose newest row is not the artifact's own updatedAt", async () => {
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				versions: [
					{
						id: "b",
						versionNumber: 5,
						author: "user",
						summary: "",
						createdAt: 2,
					},
				],
			}),
		);
		await fetchArtifactVersions("artifact-1", null, fetchMock);
		unsubscribe();
		expect(changes).toEqual([
			{
				type: "version",
				artifactId: "artifact-1",
				version: 5,
				updatedAt: null,
			},
		]);
	});

	it("announces a deletion once the server has removed the item", async () => {
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
		await expect(
			deleteArtifact("artifact-1", "conv-1", fetchMock),
		).resolves.toEqual({ ok: true, alreadyGone: false });
		unsubscribe();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts/artifact-1?conversationId=conv-1",
			{
				method: "DELETE",
			},
		);
		expect(changes).toEqual([{ type: "deleted", artifactId: "artifact-1" }]);
	});

	it("treats a 404 as already gone: announced as deleted, so an open card flips at once", async () => {
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "not_found" }, 404),
		);
		await expect(
			deleteArtifact("artifact-1", null, fetchMock),
		).resolves.toEqual({ ok: true, alreadyGone: true });
		unsubscribe();
		expect(changes).toEqual([{ type: "deleted", artifactId: "artifact-1" }]);
	});

	it("throws and announces nothing when the delete itself fails", async () => {
		const { changes, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "boom" }, 500),
		);
		await expect(
			deleteArtifact("artifact-1", null, fetchMock),
		).rejects.toMatchObject({ status: 500 });
		unsubscribe();
		expect(changes).toEqual([]);
	});

	it("announces the version a successful save reports", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, version: 4 }));
		await saveArtifactBody("artifact-1", "Text.", 3, null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([["artifact-1", 4]]);
	});

	it("announces nothing for a refused save", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "version_conflict" }, 409),
		);
		await saveArtifactBody("artifact-1", "Text.", 3, null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([]);
	});

	it("announces the version a tab save reports", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, version: 6 }));
		await saveDocumentTabs("artifact-1", [], "Text.", 5, null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([["artifact-1", 6]]);
	});

	it("announces a fetched artifact's current version", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				artifact: { id: "artifact-1", versionNumber: 7 },
				versions: [],
				comments: [],
			}),
		);
		await fetchArtifact("artifact-1", null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([["artifact-1", 7]]);
	});

	it("announces the newest row of a fetched version list — the number the Versions popover shows", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				versions: [
					{
						id: "b",
						versionNumber: 5,
						author: "user",
						summary: "",
						createdAt: 2,
					},
					{
						id: "a",
						versionNumber: 4,
						author: "alfy",
						summary: "",
						createdAt: 1,
					},
				],
			}),
		);
		await fetchArtifactVersions("artifact-1", null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([["artifact-1", 5]]);
	});

	it("announces nothing for an empty version list", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () =>
			jsonResponse({ ok: true, versions: [] }),
		);
		await fetchArtifactVersions("artifact-1", null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([]);
	});

	it("announces a restore's new version", async () => {
		const { heard, unsubscribe } = listen();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, version: 9 }));
		await restoreArtifactVersion("artifact-1", "version-1", null, fetchMock);
		unsubscribe();
		expect(heard).toEqual([["artifact-1", 9]]);
	});

	it("announces the version an App regeneration conflict reveals, and a success's", async () => {
		const { heard, unsubscribe } = listen();
		await regenerateApp(
			"artifact-1",
			"Make it blue",
			2,
			null,
			vi.fn(async () =>
				jsonResponse(
					{ ok: false, reason: "version_conflict", version: 3 },
					409,
				),
			),
		);
		await regenerateApp(
			"artifact-1",
			"Make it blue",
			3,
			null,
			vi.fn(async () =>
				jsonResponse({ ok: true, version: 4, title: "App", verification: {} }),
			),
		);
		unsubscribe();
		expect(heard).toEqual([
			["artifact-1", 3],
			["artifact-1", 4],
		]);
	});

	it("stops announcing to a listener that unsubscribed, and keeps announcing to the others", async () => {
		const first = listen();
		const second = listen();
		first.unsubscribe();
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, version: 2 }));
		await saveArtifactBody("artifact-1", "Text.", 1, null, fetchMock);
		second.unsubscribe();
		expect(first.heard).toEqual([]);
		expect(second.heard).toEqual([["artifact-1", 2]]);
	});

	it("sends the save's summary kind when one is given", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse({ ok: true, version: 4 }),
		);
		await saveArtifactBody("artifact-1", "Text.", 3, null, fetchMock, {
			summaryKind: "undid_alfy_change",
		});
		const call = fetchMock.mock.calls[0]?.[1];
		expect(JSON.parse(String(call?.body))).toEqual({
			body: "Text.",
			expectVersion: 3,
			summaryKind: "undid_alfy_change",
		});
	});
});

// Polish G2-A: "Regenerate" on a chat card whose Document or App was deleted.
describe("regenerateDeletedArtifact", () => {
	it("asks the conversation to make the item again, in the reader's language, and returns what came back", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				created: true,
				artifactId: "doc-1",
				kind: "document",
				title: "Weekend",
			}),
		);

		await expect(
			regenerateDeletedArtifact("conv-1", "doc-1", "hu", fetchMock),
		).resolves.toEqual({
			ok: true,
			created: true,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/artifacts/doc-1/regenerate",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language: "hu" }),
			},
		);
	});

	it("carries a refusal's reason instead of throwing", async () => {
		for (const [status, reason] of [
			[404, "not_found"],
			[409, "no_stored_input"],
			[409, "in_progress"],
		] as const) {
			const fetchMock = vi.fn(async () =>
				jsonResponse({ ok: false, reason }, status),
			);
			await expect(
				regenerateDeletedArtifact("conv-1", "doc-1", "en", fetchMock),
			).resolves.toEqual({ ok: false, reason });
		}
		const failed = vi.fn(async () =>
			jsonResponse({ ok: false, reason: "failed", detail: "Nope." }, 422),
		);
		await expect(
			regenerateDeletedArtifact("conv-1", "doc-1", "en", failed),
		).resolves.toEqual({ ok: false, reason: "failed", detail: "Nope." });
	});

	it("reads an unreadable answer, or a dead connection, as a plain failure", async () => {
		const html = vi.fn(async () => new Response("<html>", { status: 502 }));
		await expect(
			regenerateDeletedArtifact("conv-1", "doc-1", "en", html),
		).resolves.toEqual({ ok: false, reason: "failed" });
		const offline = vi.fn(async () => {
			throw new TypeError("network");
		});
		await expect(
			regenerateDeletedArtifact("conv-1", "doc-1", "en", offline),
		).resolves.toEqual({ ok: false, reason: "failed" });
	});
});
