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
}));

import { getArtifact } from "$lib/server/services/artifacts";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
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
		});

		expect(mockSubmitIntake).toHaveBeenCalledTimes(1);
		const call = mockSubmitIntake.mock.calls[0][0];
		expect(call.userId).toBe("owner-user");
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
