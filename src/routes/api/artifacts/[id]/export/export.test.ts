import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: only `getArtifact` is stubbed. `buildGeneratedDocumentSource`/
// `sanitizeDocumentFilename` (imported from this same facade now that the
// route no longer reaches past it into `./export` directly) keep their real
// implementations via `importOriginal`, since several assertions below check
// their REAL computed output (the document source's template, a sanitized
// filename), not a mocked stand-in.
vi.mock("$lib/server/services/artifacts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/artifacts")>();
	return {
		...actual,
		getArtifact: vi.fn(),
	};
});
vi.mock("$lib/server/services/file-production", () => ({
	submitFileProductionIntake: vi.fn(),
	ARTIFACT_EXPORT_JOB_ORIGIN: "artifact_export",
}));

import { getArtifact } from "$lib/server/services/artifacts";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { EMPTY_TAB_ANCHOR_PLACEHOLDER } from "$lib/shared/artifact-document/blocks";
import { POST } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockSubmitIntake = submitFileProductionIntake as ReturnType<typeof vi.fn>;

const DOCUMENT_BODY = "<!--b:p1-->\nBook the flight to Vienna.";

function artifactFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "artifact-1",
		kind: "document" as const,
		title: "Vienna, 10–12 October",
		conversationId: "conv-1",
		versionNumber: 1,
		commentCount: 0,
		updatedAt: 1,
		body: DOCUMENT_BODY,
		bodyHash: "hash",
		metadata: { artifactType: "document", title: "Vienna, 10–12 October" },
		...overrides,
	};
}

function makeEvent(params: {
	id?: string;
	userId?: string | null;
	body?: unknown;
	conversationId?: string | null;
}) {
	const {
		id = "artifact-1",
		userId = "owner-user",
		body = { format: "pdf" },
		conversationId = null,
	} = params;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/export${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { json: async () => body },
	} as never;
}

describe("POST /api/artifacts/[id]/export", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	it("404s a missing or foreign artifact", async () => {
		mockGetArtifact.mockResolvedValue(null);
		const response = await POST(makeEvent({}));
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	it("404s a non-document artifact", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture({ kind: "canvas" }));
		const response = await POST(makeEvent({}));
		expect(response.status).toBe(404);
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	// T12.8: unreachable through this slice's own creation paths, but createArtifact
	// itself allows conversationId: null, so the route must answer this cleanly.
	it("409s with no_conversation for a document created with no conversation, never a 500", async () => {
		mockGetArtifact.mockResolvedValue(
			artifactFixture({ conversationId: null }),
		);
		const response = await POST(makeEvent({}));
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "no_conversation",
		});
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	// FB-8 (FB-1's concern 1): the same item, as it is now, in the same format is the
	// same job, so a repeated press is handed the file the last one made.
	it("asks for the same job for the same document and format, and never for a failed one", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1", status: "queued" },
			reused: false,
		});

		await POST(makeEvent({}));
		await POST(makeEvent({}));
		await POST(makeEvent({ body: { format: "docx" } }));

		const calls = mockSubmitIntake.mock.calls.map(([call]) => call);
		const keys = calls.map((call) => call.body.idempotencyKey as string);
		expect(keys[0]).toMatch(
			/^artifact-export:artifact-1:pdf:v\d+:[0-9a-f]{32}$/,
		);
		expect(keys[1]).toBe(keys[0]);
		// Another format is another file.
		expect(keys[2]).toMatch(
			/^artifact-export:artifact-1:docx:v\d+:[0-9a-f]{32}$/,
		);
		for (const call of calls) expect(call.reuse).toBe("usable");
	});

	// RV-B M2: the press that is handed a job an earlier press made must know it, as the
	// App's route already says, so it does not stop a job that is not its own.
	it("says whether the job is one an earlier press made", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		for (const reused of [false, true]) {
			mockSubmitIntake.mockResolvedValue({
				ok: true,
				status: 202,
				job: { id: "job-1", status: "running" },
				reused,
			});

			const response = await POST(makeEvent({}));

			await expect(response.json()).resolves.toEqual({
				ok: true,
				job: { id: "job-1", status: "running" },
				reused,
			});
		}
	});

	it("asks for a new job once the document's words or its title have changed, and only then", async () => {
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1", status: "queued" },
			reused: false,
		});
		const keyFor = async (overrides: Record<string, unknown>) => {
			mockSubmitIntake.mockClear();
			mockGetArtifact.mockResolvedValue(artifactFixture(overrides));
			await POST(makeEvent({}));
			return mockSubmitIntake.mock.calls[0][0].body.idempotencyKey as string;
		};

		const base = await keyFor({});
		// A coalesced save keeps the version number and changes the words (RC-V M-1).
		expect(
			await keyFor({ body: `${DOCUMENT_BODY} Window seat.`, versionNumber: 1 }),
		).not.toBe(base);
		expect(await keyFor({ title: "Vienna, 10–13 October" })).not.toBe(base);
		// What does not change the file does not change the key.
		expect(await keyFor({ versionNumber: 2, updatedAt: 99 })).toBe(base);
	});

	it("submits a document_source intake for pdf, with requestedOutputs (never outputs)", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: false,
		});

		const response = await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "pdf" } }),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			job: { id: "job-1" },
			reused: false,
		});

		expect(mockSubmitIntake).toHaveBeenCalledTimes(1);
		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.userId).toBe("owner-user");
		// The reader's own export, never a reply's card (friction audit F1).
		expect(call.origin).toBe("artifact_export");
		expect(call.body.conversationId).toBe("conv-1");
		expect(call.body.sourceMode).toBe("document_source");
		expect(call.body.documentSource.template).toBe("alfyai_standard_report");
		expect(call.body.requestedOutputs).toEqual([{ type: "pdf" }]);
		expect(call.body.outputs).toBeUndefined();
		// The server reads the CURRENT stored body — never a client-sent one.
		expect(JSON.stringify(call.body.documentSource)).not.toContain("<!--b:");
	});

	it("submits a document_source intake for docx", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-2" },
			reused: false,
		});

		await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "docx" } }),
		);

		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.body.requestedOutputs).toEqual([{ type: "docx" }]);
	});

	it("submits an inline_text intake for markdown, with the marker lines stripped", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-3" },
			reused: false,
		});

		await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "markdown" } }),
		);

		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.body.sourceMode).toBe("inline_text");
		expect(call.body.inlineText.files).toHaveLength(1);
		expect(call.body.inlineText.files[0].outputType).toBe("md");
		expect(call.body.inlineText.files[0].filename).toMatch(/\.md$/);
		expect(call.body.inlineText.files[0].filename).not.toContain("/");
		expect(call.body.inlineText.content).not.toContain("<!--b:");
		expect(call.body.inlineText.content).toContain(
			"Book the flight to Vienna.",
		);
	});

	// rd/review-2-5.md's fix-agent-B finding 7 (verified by fix agent C): a
	// still-empty new tab's own anchor paragraph is a single zero-width space
	// (`appendEmptyTabSection`) — real content to the STORED body, but an
	// exported .md file must not carry it as if the user had typed it there.
	it("strips a still-empty new tab's zero-width-space placeholder from the exported Markdown", async () => {
		mockGetArtifact.mockResolvedValue(
			artifactFixture({
				body: `${DOCUMENT_BODY}\n\n<!--b:p2-->\n${EMPTY_TAB_ANCHOR_PLACEHOLDER}`,
			}),
		);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-zwsp" },
			reused: false,
		});

		await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "markdown" } }),
		);

		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.body.inlineText.content).not.toContain(
			EMPTY_TAB_ANCHOR_PLACEHOLDER,
		);
		expect(call.body.inlineText.content).toBe("Book the flight to Vienna.");
	});

	it("falls back to document.md when the title cannot make a sane filename", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture({ title: "   " }));
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-4" },
			reused: false,
		});

		await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "markdown" } }),
		);

		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.body.inlineText.files[0].filename).toBe("document.md");
	});

	it("passes through the intake's own failure status and reason (e.g. a limit refusal)", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		mockSubmitIntake.mockResolvedValue({
			ok: false,
			status: 422,
			code: "source_too_large",
			error: "The file production source is too large.",
		});

		const response = await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "pdf" } }),
		);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "source_too_large",
		});
	});

	it("400s an unrecognized format before ever calling the intake", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture());
		const response = await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "xlsx" } }),
		);
		expect(response.status).toBe(400);
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});
});

// RV-1A (independent review of Slice 1): red before its fix; the review file
// (docs/plans/claude-at-home-2/review-1a.md) quotes the failing line.
describe("RV-1A: the Markdown export removes markers, never content", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps a code block's line that merely looks like a marker", async () => {
		mockGetArtifact.mockResolvedValue(
			artifactFixture({
				body: "<!--b:p1-->\nHow the ids look:\n\n<!--b:c1-->\n```html\n<!--b:example-->\n<p>Hi</p>\n```\n",
			}),
		);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-9" },
			reused: false,
		});

		await POST(
			makeEvent({ conversationId: "conv-1", body: { format: "markdown" } }),
		);

		const content = mockSubmitIntake.mock.calls[0][0].body.inlineText.content;
		expect(content).toBe(
			"How the ids look:\n\n```html\n<!--b:example-->\n<p>Hi</p>\n```",
		);
	});
});
