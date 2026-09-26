import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUTS_MS } from "../shared";

const createAppFromBrief = vi.fn();
vi.mock("$lib/server/services/artifacts/app/create", () => ({
	createAppFromBrief: (params: unknown) => createAppFromBrief(params),
}));

import {
	CREATABLE_ARTIFACT_KINDS,
	CREATE_ARTIFACT_HANDLERS,
	type CreateArtifactHandler,
	createArtifactInputSchema,
	createArtifactModelInputSchema,
	runCreateArtifactTool,
} from "./create";

/** The kinds this test file's own "no handler registered" assertions still
 * cover — "app" is registered for real (Slice 2, Task A7) and gets its own
 * describe block below instead. */
const UNREGISTERED_KINDS = CREATABLE_ARTIFACT_KINDS.filter(
	(kind) => kind !== "app",
);

describe("createArtifactModelInputSchema / createArtifactInputSchema", () => {
	it("advertises the four creatable kinds", () => {
		expect(CREATABLE_ARTIFACT_KINDS).toEqual([
			"document",
			"app",
			"canvas",
			"slides",
		]);
	});

	it("accepts a minimal valid input on both schemas", () => {
		const input = {
			artifactType: "document",
			title: "Vienna plan",
			body: "# Plan",
		};
		expect(createArtifactModelInputSchema.safeParse(input).success).toBe(true);
		expect(createArtifactInputSchema.safeParse(input).success).toBe(true);
	});

	it("the executed schema enforces the server's title bound", () => {
		const tooLong = {
			artifactType: "document",
			title: "x".repeat(201),
			body: "b",
		};
		expect(createArtifactInputSchema.safeParse(tooLong).success).toBe(false);
	});

	it("rejects a kind outside the creatable four, including file", () => {
		const input = { artifactType: "file", title: "t", body: "b" };
		expect(createArtifactInputSchema.safeParse(input).success).toBe(false);
	});

	it("rejects an empty body", () => {
		const input = { artifactType: "document", title: "t", body: "" };
		expect(createArtifactInputSchema.safeParse(input).success).toBe(false);
	});
});

describe("runCreateArtifactTool — no kind registered yet (Slice 5a)", () => {
	afterEach(() => {
		for (const kind of UNREGISTERED_KINDS) {
			delete CREATE_ARTIFACT_HANDLERS[kind];
		}
	});

	it("refuses every still-unregistered kind with a model-safe failure, not a throw", async () => {
		for (const artifactType of UNREGISTERED_KINDS) {
			const result = await runCreateArtifactTool({
				userId: "user-1",
				conversationId: "conv-1",
				turnId: "turn-1",
				title: "Something",
				body: "content",
				language: "en",
				artifactType,
				abortSignal: new AbortController().signal,
			});

			expect(result.modelPayload.success).toBe(false);
			if (!result.modelPayload.success) {
				expect(result.modelPayload.error.length).toBeGreaterThan(0);
			}
			expect(result.metadata.ok).toBe(false);
		}
	});
});

describe("runCreateArtifactTool — a registered handler", () => {
	afterEach(() => {
		delete CREATE_ARTIFACT_HANDLERS.document;
	});

	it("returns the artifact id, kind and title on success, with tool-call metadata", async () => {
		const handler: CreateArtifactHandler = async (params) => ({
			ok: true,
			value: {
				artifactId: "artifact-1",
				title: params.title,
				versionId: "version-1",
			},
		});
		CREATE_ARTIFACT_HANDLERS.document = handler;

		const result = await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "Vienna plan",
			body: "# Plan",
			language: "en",
			artifactType: "document",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toEqual({
			success: true,
			artifactId: "artifact-1",
			artifactType: "document",
			title: "Vienna plan",
			versionId: "version-1",
		});
		expect(result.metadata).toEqual({
			ok: true,
			artifactId: "artifact-1",
			artifactKind: "document",
			artifactTitle: "Vienna plan",
		});
	});

	it("surfaces a handler's domain refusal as a model-safe failure", async () => {
		const handler: CreateArtifactHandler = async () => ({
			ok: false,
			reason: "The Markdown could not be parsed into blocks.",
		});
		CREATE_ARTIFACT_HANDLERS.document = handler;

		const result = await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "Vienna plan",
			body: "# Plan",
			language: "en",
			artifactType: "document",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toEqual({
			success: false,
			error: "The Markdown could not be parsed into blocks.",
		});
		expect(result.metadata.ok).toBe(false);
	});

	it("passes its own abortSignal through to the handler unchanged", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const handler: CreateArtifactHandler = async (params) => {
			seenSignal = params.abortSignal;
			return {
				ok: true,
				value: { artifactId: "artifact-1", title: params.title },
			};
		};
		CREATE_ARTIFACT_HANDLERS.document = handler;

		await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "Vienna plan",
			body: "# Plan",
			language: "en",
			artifactType: "document",
			abortSignal: controller.signal,
		});

		expect(seenSignal).toBe(controller.signal);
	});
});

describe("create_artifact's timeout row (A7.5)", () => {
	it("clears the real App generation cost: >= 120s, so a missing/short row fails loudly instead of leaving the tool with no timeout at all", () => {
		// shared.ts:343-350's map lookup yields undefined with no row at all —
		// Number.isFinite(undefined) is false, no timer is armed, and the tool
		// silently gets NO timeout. This assertion is the App handler's own
		// stake in that row: 23s worst measured generation + ~5s classifier +
		// research_web's own 60s ceiling + ~25s re-verification budget ≈ 113s,
		// rounded up (decisions.md ruling 40, owned by Slice 5a's registry —
		// this slice references it rather than restating it).
		expect(TOOL_TIMEOUTS_MS.create_artifact).toBeGreaterThanOrEqual(120_000);
	});
});

describe("CREATE_ARTIFACT_HANDLERS.app (Task A7)", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches to createAppFromBrief with the tool's own fields — the model's body as the brief, never as literal html", async () => {
		createAppFromBrief.mockResolvedValue({
			ok: true,
			artifactId: "artifact-1",
			title: "Trip cost splitter",
			verification: { checked: false, verdict: "clean", reason: null },
		});

		const result = await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "Trip cost splitter",
			body: "Split costs between three friends on a trip.",
			language: "en",
			artifactType: "app",
			abortSignal: new AbortController().signal,
		});

		expect(createAppFromBrief).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				title: "Trip cost splitter",
				prompt: "Split costs between three friends on a trip.",
				language: "en",
			}),
		);
		expect(result.modelPayload).toEqual({
			success: true,
			artifactId: "artifact-1",
			artifactType: "app",
			title: "Trip cost splitter",
			versionId: undefined,
		});
	});

	it("threads the turn's resolved language through to createAppFromBrief unchanged (ruling 55)", async () => {
		createAppFromBrief.mockResolvedValue({
			ok: true,
			artifactId: "artifact-1",
			title: "Kvíz",
			verification: { checked: false, verdict: "clean", reason: null },
		});

		await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "Kvíz",
			body: "Készíts egy kvízt",
			language: "hu",
			artifactType: "app",
			abortSignal: new AbortController().signal,
		});

		expect(createAppFromBrief).toHaveBeenCalledWith(
			expect.objectContaining({ language: "hu" }),
		);
	});

	it("passes the envelope's abortSignal through unchanged", async () => {
		createAppFromBrief.mockResolvedValue({
			ok: true,
			artifactId: "artifact-1",
			title: "x",
			verification: { checked: false, verdict: "clean", reason: null },
		});
		const controller = new AbortController();

		await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "x",
			body: "a brief",
			language: "en",
			artifactType: "app",
			abortSignal: controller.signal,
		});

		expect(createAppFromBrief).toHaveBeenCalledWith(
			expect.objectContaining({ abortSignal: controller.signal }),
		);
	});

	it("surfaces a generation/verification failure as a model-safe refusal, never a thrown error", async () => {
		createAppFromBrief.mockResolvedValue({
			ok: false,
			reason: "no_fence",
			detail: "no html fence and no complete html document in the answer",
		});

		const result = await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "x",
			body: "a brief",
			language: "en",
			artifactType: "app",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toEqual({
			success: false,
			error: "no html fence and no complete html document in the answer",
		});
		expect(result.metadata.ok).toBe(false);
	});

	it("never leaks the generated html anywhere in the tool's model payload or metadata (A7.4)", async () => {
		const secretHtml =
			"<html><body>the generated app's actual markup</body></html>";
		createAppFromBrief.mockResolvedValue({
			ok: true,
			artifactId: "artifact-1",
			title: "x",
			verification: { checked: false, verdict: "clean", reason: null },
		});

		const result = await runCreateArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			title: "x",
			body: "a brief",
			language: "en",
			artifactType: "app",
			abortSignal: new AbortController().signal,
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(secretHtml);
		expect(serialized).not.toContain("<html");
	});
});
