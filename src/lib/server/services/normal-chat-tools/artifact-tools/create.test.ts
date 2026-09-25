import { afterEach, describe, expect, it } from "vitest";
import {
	CREATABLE_ARTIFACT_KINDS,
	CREATE_ARTIFACT_HANDLERS,
	type CreateArtifactHandler,
	createArtifactInputSchema,
	createArtifactModelInputSchema,
	runCreateArtifactTool,
} from "./create";

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
		for (const kind of CREATABLE_ARTIFACT_KINDS) {
			delete CREATE_ARTIFACT_HANDLERS[kind];
		}
	});

	it("refuses every creatable kind with a model-safe failure, not a throw", async () => {
		for (const artifactType of CREATABLE_ARTIFACT_KINDS) {
			const result = await runCreateArtifactTool({
				userId: "user-1",
				conversationId: "conv-1",
				turnId: "turn-1",
				title: "Something",
				body: "content",
				artifactType,
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
			artifactType: "document",
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
			artifactType: "document",
		});

		expect(result.modelPayload).toEqual({
			success: false,
			error: "The Markdown could not be parsed into blocks.",
		});
		expect(result.metadata.ok).toBe(false);
	});
});
