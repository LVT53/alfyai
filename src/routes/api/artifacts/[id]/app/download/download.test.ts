import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
}));
vi.mock("$lib/server/services/file-production", () => ({
	submitFileProductionIntake: vi.fn(),
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
		const [{ userId, body }] = mockSubmitIntake.mock.calls[0];
		expect(userId).toBe("owner-user");
		expect(body).toMatchObject({
			conversationId: "conv-1",
			idempotencyKey: "app-html:app-1:3",
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
