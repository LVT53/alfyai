import { beforeEach, describe, expect, it, vi } from "vitest";

// The key is the artifacts service's own function: its real implementation runs.
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
import { POST } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockSubmitIntake = submitFileProductionIntake as ReturnType<typeof vi.fn>;

const APP_ARTIFACT = {
	id: "app-1",
	kind: "app" as const,
	title: "Trip cost splitter",
	conversationId: "conv-1",
	versionNumber: 3,
	commentCount: 0,
	updatedAt: 1,
	body: "<!doctype html><title>Split</title>",
	bodyHash: "hash",
	metadata: { artifactType: "app" as const, title: "Trip cost splitter" },
};

function makeEvent(userId: string | null = "owner-user", body: unknown = {}) {
	return {
		params: { id: "app-1" },
		url: new URL("http://localhost/api/artifacts/app-1/app/download"),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { json: async () => body },
	} as never;
}

describe("POST /api/artifacts/[id]/app/download", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user", async () => {
		await expect(POST(makeEvent(null))).rejects.toMatchObject({ status: 401 });
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	it("404s for a foreign, missing, or non-App artifact", async () => {
		mockGetArtifact.mockResolvedValue(null);
		const response = await POST(makeEvent());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	it("refuses a project-linked App (no conversation) without calling the intake", async () => {
		mockGetArtifact.mockResolvedValue({
			...APP_ARTIFACT,
			conversationId: null,
		});
		const response = await POST(makeEvent());
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "conversation_required",
		});
		expect(mockSubmitIntake).not.toHaveBeenCalled();
	});

	it("builds the intake body from the artifact's OWN freshly-read fields, base64-encoding the body server-side", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: false,
		});

		await POST(makeEvent());

		expect(mockSubmitIntake).toHaveBeenCalledTimes(1);
		const [{ userId, body, origin }] = mockSubmitIntake.mock.calls[0];
		expect(userId).toBe("owner-user");
		// The reader's own export: no reply is ever handed it as a card (F1).
		expect(origin).toBe("artifact_export");
		expect(body).toMatchObject({
			conversationId: "conv-1",
			requestTitle: "Trip cost splitter — app source",
			sourceMode: "program",
			outputs: [{ type: "html" }],
		});
		// The request the component could have composed from a client-side HTML
		// string never reaches here: the source is built from artifact.body,
		// read by THIS handler, not accepted as a request field.
		expect(body.program.sourceCode).toContain(
			Buffer.from(APP_ARTIFACT.body, "utf8").toString("base64"),
		);
		expect(body.program.filename).toBe("app.html");
	});

	// FB-8 (FB-1's concern 1): the same App, as it is now, is the same file. A press
	// after one that worked is handed the file it made; a job an earlier press left
	// failed (no sandbox, a timeout) is not handed back as the same failure, which is
	// what asking for `reuse: "usable"` is for.
	it("asks for the same job for the same App as it is now, and never for a failed one", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: false,
		});

		await POST(makeEvent());
		await POST(makeEvent());

		const calls = mockSubmitIntake.mock.calls.map(([call]) => call);
		const keys = calls.map((call) => call.body.idempotencyKey as string);
		expect(keys[0]).toMatch(/^artifact-export:app-1:html:[0-9a-f]{32}$/);
		expect(keys[1]).toBe(keys[0]);
		for (const call of calls) expect(call.reuse).toBe("usable");
	});

	it("asks for a new job once the App's words or its title have changed, and only then", async () => {
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: false,
		});
		const keyFor = async (overrides: Record<string, unknown>) => {
			mockSubmitIntake.mockClear();
			mockGetArtifact.mockResolvedValue({ ...APP_ARTIFACT, ...overrides });
			await POST(makeEvent());
			return mockSubmitIntake.mock.calls[0][0].body.idempotencyKey as string;
		};

		const base = await keyFor({});
		// A coalesced save keeps the version number and changes the words.
		expect(
			await keyFor({ body: "<!doctype html><title>Split 2</title>" }),
		).not.toBe(base);
		expect(await keyFor({ title: "Trip splitter" })).not.toBe(base);
		// What does not change the file does not change the key.
		expect(await keyFor({ versionNumber: 4, updatedAt: 99 })).toBe(base);
	});

	it("ignores any HTML the request body might contain — there is no field that could carry it into the intake", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: false,
		});

		await POST(
			makeEvent("owner-user", {
				html: "<html>forged</html>",
				conversationId: "conv-1",
			}),
		);

		const [{ body }] = mockSubmitIntake.mock.calls[0];
		expect(body.program.sourceCode).not.toContain("forged");
		expect(body.program.sourceCode).toContain(
			Buffer.from(APP_ARTIFACT.body, "utf8").toString("base64"),
		);
	});

	it("wraps the intake result in ruling 49's { ok: true, … } success shape", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);
		mockSubmitIntake.mockResolvedValue({
			ok: true,
			status: 202,
			job: { id: "job-1" },
			reused: true,
		});

		const response = await POST(makeEvent());
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			ok: true,
			job: { id: "job-1" },
			reused: true,
		});
	});

	it("forwards the intake's own failure status and code", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);
		mockSubmitIntake.mockResolvedValue({
			ok: false,
			status: 429,
			code: "rate_limited",
			error: "too many requests",
		});

		const response = await POST(makeEvent());
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "rate_limited",
		});
	});
});
