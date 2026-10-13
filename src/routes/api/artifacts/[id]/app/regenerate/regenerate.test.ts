import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts/app/regenerate", () => ({
	regenerateApp: vi.fn(),
}));

import { regenerateApp } from "$lib/server/services/artifacts/app/regenerate";
import { POST } from "./+server";

const mockRegenerateApp = regenerateApp as ReturnType<typeof vi.fn>;

function makeEvent(
	userId: string | null,
	body: unknown,
	userOverrides: Record<string, unknown> = {},
	requestSignal: AbortSignal = new AbortController().signal,
) {
	return {
		params: { id: "app-1" },
		url: new URL("http://localhost/api/artifacts/app-1/app/regenerate"),
		locals: {
			user: userId
				? { id: userId, role: "user", uiLanguage: "en", ...userOverrides }
				: undefined,
		},
		request: { json: async () => body, signal: requestSignal },
	} as never;
}

describe("POST /api/artifacts/[id]/app/regenerate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(
			POST(makeEvent(null, { prompt: "add a currency switch" })),
		).rejects.toMatchObject({ status: 401 });
		expect(mockRegenerateApp).not.toHaveBeenCalled();
	});

	it("422s when the prompt is missing or empty, without calling the service", async () => {
		const missing = await POST(makeEvent("owner-user", {}));
		expect(missing.status).toBe(422);
		const empty = await POST(makeEvent("owner-user", { prompt: "   " }));
		expect(empty.status).toBe(422);
		expect(mockRegenerateApp).not.toHaveBeenCalled();
	});

	it("200s with the service's result on success", async () => {
		mockRegenerateApp.mockResolvedValue({
			ok: true,
			version: 2,
			title: "Habit tracker",
			verification: { checked: true, verdict: "clean", reason: null },
		});

		const response = await POST(
			makeEvent("owner-user", { prompt: "add a currency switch" }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			version: 2,
			title: "Habit tracker",
			verification: { checked: true, verdict: "clean", reason: null },
		});
	});

	it("404s not_found", async () => {
		mockRegenerateApp.mockResolvedValue({ ok: false, reason: "not_found" });
		const response = await POST(makeEvent("owner-user", { prompt: "x" }));
		expect(response.status).toBe(404);
	});

	it("409s version_conflict and carries the current version, keeping the prompt out of it (client-side responsibility)", async () => {
		mockRegenerateApp.mockResolvedValue({
			ok: false,
			reason: "version_conflict",
			version: 4,
		});

		const response = await POST(
			makeEvent("owner-user", {
				prompt: "add a currency switch",
				expectVersion: 1,
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "version_conflict",
			version: 4,
		});
	});

	it("422s a generation failure reason with its detail", async () => {
		mockRegenerateApp.mockResolvedValue({
			ok: false,
			reason: "no_fence",
			detail: "the answer did not contain a runnable app",
		});

		const response = await POST(makeEvent("owner-user", { prompt: "x" }));

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "no_fence",
			detail: "the answer did not contain a runnable app",
		});
	});

	it("passes expectVersion through only when it is a number, and the prompt as the person wrote it", async () => {
		mockRegenerateApp.mockResolvedValue({
			ok: true,
			version: 2,
			title: "x",
			verification: { checked: false, verdict: "clean", reason: null },
		});

		await POST(
			makeEvent("owner-user", {
				prompt: "Segíts egy bevásárlólistát",
				expectVersion: 3,
			}),
		);

		expect(mockRegenerateApp).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner-user",
				artifactId: "app-1",
				prompt: "Segíts egy bevásárlólistát",
				expectVersion: 3,
			}),
		);
		// No language is decided here: the generator reads the person's words,
		// and an App keeps the language it is in unless the words ask for another.
		expect(mockRegenerateApp.mock.calls[0][0]).not.toHaveProperty("language");
	});

	// Ruling 53: generation+verification can run for tens of seconds, and if
	// the caller (the panel's own fetch) disconnects mid-flight, the pipeline
	// must be told — otherwise regenerateApp has no way to know the call was
	// abandoned and a version gets written nobody is waiting for. SvelteKit
	// surfaces that as the request's own AbortSignal.
	it("passes the request's own AbortSignal through as abortSignal", async () => {
		mockRegenerateApp.mockResolvedValue({
			ok: true,
			version: 2,
			title: "x",
			verification: { checked: false, verdict: "clean", reason: null },
		});
		const controller = new AbortController();

		await POST(
			makeEvent(
				"owner-user",
				{ prompt: "add a currency switch" },
				{},
				controller.signal,
			),
		);

		expect(mockRegenerateApp).toHaveBeenCalledWith(
			expect.objectContaining({ abortSignal: controller.signal }),
		);
	});
});
