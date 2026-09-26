import { beforeEach, describe, expect, it, vi } from "vitest";

const generateAndVerifyApp = vi.fn();
const maybeRecordAppVerificationComment = vi.fn().mockResolvedValue(undefined);
vi.mock("./generate-and-verify", () => ({
	generateAndVerifyApp: (params: unknown) => generateAndVerifyApp(params),
	maybeRecordAppVerificationComment: (params: unknown) =>
		maybeRecordAppVerificationComment(params),
}));

const createArtifact = vi.fn();
vi.mock("../record", () => ({
	createArtifact: (params: unknown) => createArtifact(params),
}));

const detectLanguage = vi.fn((_text: string): "en" | "hu" => "en");
vi.mock("$lib/server/services/language", () => ({
	detectLanguage: (text: string) => detectLanguage(text),
}));

const { createAppFromBrief } = await import("./create");

function baseInput(
	overrides: Partial<Parameters<typeof createAppFromBrief>[0]> = {},
) {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		title: "Trip cost splitter",
		prompt: "Split costs between three friends on a trip.",
		...overrides,
	};
}

function verifiedOutcome(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		value: {
			html: "<html><body>an app</body></html>",
			title: "Trip cost splitter",
			glitchRuleIds: [],
			verification: { checked: true, verdict: "clean", reason: null },
			findings: [],
			...overrides,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	detectLanguage.mockReturnValue("en");
	maybeRecordAppVerificationComment.mockResolvedValue(undefined);
});

describe("createAppFromBrief — the happy path", () => {
	it("generates, verifies and writes a new artifact with author alfy", async () => {
		generateAndVerifyApp.mockResolvedValue(verifiedOutcome());
		createArtifact.mockResolvedValue({
			ok: true,
			artifact: { id: "artifact-1", title: "Trip cost splitter" },
		});

		const result = await createAppFromBrief(baseInput());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.artifactId).toBe("artifact-1");
			expect(result.title).toBe("Trip cost splitter");
		}
		expect(createArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				kind: "app",
				title: "Trip cost splitter",
				body: "<html><body>an app</body></html>",
				author: "alfy",
			}),
		);
	});

	it("passes the model's own title into generation, so it wins over any derived <title>/<h1>", async () => {
		generateAndVerifyApp.mockResolvedValue(verifiedOutcome());
		createArtifact.mockResolvedValue({
			ok: true,
			artifact: { id: "artifact-1", title: "Trip cost splitter" },
		});

		await createAppFromBrief(baseInput({ title: "My custom title" }));

		expect(generateAndVerifyApp).toHaveBeenCalledWith(
			expect.objectContaining({ title: "My custom title" }),
		);
	});

	it("detects the language from the model's brief, not a hardcoded default", async () => {
		detectLanguage.mockReturnValue("hu");
		generateAndVerifyApp.mockResolvedValue(verifiedOutcome());
		createArtifact.mockResolvedValue({
			ok: true,
			artifact: { id: "artifact-1", title: "x" },
		});

		await createAppFromBrief(baseInput({ prompt: "Készíts egy kvízt" }));

		expect(detectLanguage).toHaveBeenCalledWith("Készíts egy kvízt");
		expect(generateAndVerifyApp).toHaveBeenCalledWith(
			expect.objectContaining({ language: "hu" }),
		);
	});

	it("persists the glitch rule ids and verification summary as metadata", async () => {
		generateAndVerifyApp.mockResolvedValue(
			verifiedOutcome({
				glitchRuleIds: ["no-script-src"],
				verification: { checked: true, verdict: "repaired", reason: null },
			}),
		);
		createArtifact.mockResolvedValue({
			ok: true,
			artifact: { id: "artifact-1", title: "x" },
		});

		await createAppFromBrief(baseInput());

		expect(createArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: {
					glitchRuleIds: ["no-script-src"],
					verification: { checked: true, verdict: "repaired", reason: null },
				},
			}),
		);
	});

	it("writes Alfy's verification comment AFTER the artifact exists, with the real artifact id", async () => {
		const findings = [{ claim: "Total: 900", problem: "wrong" }];
		generateAndVerifyApp.mockResolvedValue(
			verifiedOutcome({
				verification: { checked: true, verdict: "uncertain", reason: null },
				findings,
			}),
		);
		const order: string[] = [];
		createArtifact.mockImplementation(async () => {
			order.push("createArtifact");
			return { ok: true, artifact: { id: "artifact-1", title: "x" } };
		});
		maybeRecordAppVerificationComment.mockImplementation(async () => {
			order.push("comment");
		});

		await createAppFromBrief(baseInput());

		expect(order).toEqual(["createArtifact", "comment"]);
		expect(maybeRecordAppVerificationComment).toHaveBeenCalledWith(
			expect.objectContaining({ artifactId: "artifact-1", findings }),
		);
	});
});

describe("createAppFromBrief — generation/verification failure", () => {
	it("never calls createArtifact when generation fails, and reports the model-safe reason", async () => {
		generateAndVerifyApp.mockResolvedValue({
			ok: false,
			reason: "no_fence",
			detail: "no html fence in the answer",
		});

		const result = await createAppFromBrief(baseInput());

		expect(result.ok).toBe(false);
		if (!result.ok && result.reason !== "aborted") {
			expect(result.reason).toBe("no_fence");
		}
		expect(createArtifact).not.toHaveBeenCalled();
	});
});

describe("createAppFromBrief — ruling 53: writes nothing after an abort", () => {
	it("does not call createArtifact when the signal is already aborted before generation starts", async () => {
		const controller = new AbortController();
		controller.abort(new Error("turn stopped"));

		const result = await createAppFromBrief(
			baseInput({ abortSignal: controller.signal }),
		);

		expect(result.ok).toBe(false);
		expect(generateAndVerifyApp).not.toHaveBeenCalled();
		expect(createArtifact).not.toHaveBeenCalled();
	});

	it("does not call createArtifact when the signal aborts AFTER generation/verification succeed but before the write", async () => {
		const controller = new AbortController();
		generateAndVerifyApp.mockImplementation(async () => {
			// The tool's own timeout fires while the App was mid-flight — the
			// model was already told the call failed by the time this resolves.
			controller.abort(new Error("timed out"));
			return verifiedOutcome();
		});

		const result = await createAppFromBrief(
			baseInput({ abortSignal: controller.signal }),
		);

		expect(result.ok).toBe(false);
		expect(createArtifact).not.toHaveBeenCalled();
	});
});
