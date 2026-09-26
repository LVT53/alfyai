import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts/app/regenerate", () => ({
	regenerateApp: vi.fn(),
}));

// resolveTurnResponseLanguage's only DB-touching dependency (messages.ts's
// listRecentUserMessageTexts) — mocked at this seam, like send.test.ts does,
// so the route's language resolution runs for REAL (still pure/sync from
// here down) without a live database.
const mockListRecentUserMessageTexts = vi.fn().mockResolvedValue([]);
vi.mock("$lib/server/services/messages", () => ({
	listRecentUserMessageTexts: (
		conversationId: string,
		userId: string,
		limit?: number,
	) => mockListRecentUserMessageTexts(conversationId, userId, limit),
}));

import { regenerateApp } from "$lib/server/services/artifacts/app/regenerate";
import { POST } from "./+server";

const mockRegenerateApp = regenerateApp as ReturnType<typeof vi.fn>;

function makeEvent(
	userId: string | null,
	body: unknown,
	userOverrides: Record<string, unknown> = {},
) {
	return {
		params: { id: "app-1" },
		url: new URL("http://localhost/api/artifacts/app-1/app/regenerate"),
		locals: {
			user: userId
				? { id: userId, role: "user", uiLanguage: "en", ...userOverrides }
				: undefined,
		},
		request: { json: async () => body },
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

	it("passes expectVersion through only when it is a number, and detects the prompt's own language", async () => {
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
				language: "hu",
			}),
		);
	});

	// Ruling 55: the panel's regenerate resolves language through the SAME
	// policy a chat turn does (prompt -> conversation's established language
	// -> UI language), not the retired per-message detectLanguage guess.
	describe("resolves language the same way a chat turn does (ruling 55)", () => {
		it("falls back to the conversation's established language when the prompt itself is ambiguous", async () => {
			mockListRecentUserMessageTexts.mockResolvedValueOnce([
				"Csinálj egy szokáskövetőt",
			]);
			mockRegenerateApp.mockResolvedValue({
				ok: true,
				version: 2,
				title: "x",
				verification: { checked: false, verdict: "clean", reason: null },
			});

			await POST(
				makeEvent(
					"owner-user",
					// "ok" alone is too short/ambiguous for classifyLanguageSignal to
					// call on its own — it must fall through to conversation history.
					{ prompt: "ok", conversationId: "conv-1" },
					{ uiLanguage: "en" },
				),
			);

			expect(mockListRecentUserMessageTexts).toHaveBeenCalledWith(
				"conv-1",
				"owner-user",
				expect.any(Number),
			);
			expect(mockRegenerateApp).toHaveBeenCalledWith(
				expect.objectContaining({ language: "hu", conversationId: "conv-1" }),
			);
		});

		it("falls back to the account's UI language when the prompt is ambiguous and there is no conversation history", async () => {
			mockListRecentUserMessageTexts.mockResolvedValueOnce([]);
			mockRegenerateApp.mockResolvedValue({
				ok: true,
				version: 2,
				title: "x",
				verification: { checked: false, verdict: "clean", reason: null },
			});

			await POST(
				makeEvent(
					"owner-user",
					{ prompt: "ok", conversationId: "conv-1" },
					{ uiLanguage: "hu" },
				),
			);

			expect(mockRegenerateApp).toHaveBeenCalledWith(
				expect.objectContaining({ language: "hu" }),
			);
		});

		it("never looks up conversation history for a project-linked App with no conversationId, and still resolves the UI-language fallback", async () => {
			mockRegenerateApp.mockResolvedValue({
				ok: true,
				version: 2,
				title: "x",
				verification: { checked: false, verdict: "clean", reason: null },
			});

			await POST(
				makeEvent("owner-user", { prompt: "ok" }, { uiLanguage: "hu" }),
			);

			expect(mockListRecentUserMessageTexts).not.toHaveBeenCalled();
			expect(mockRegenerateApp).toHaveBeenCalledWith(
				expect.objectContaining({ language: "hu", conversationId: null }),
			);
		});

		it("an explicit instruction in the prompt wins over both the conversation history and the UI language", async () => {
			mockListRecentUserMessageTexts.mockResolvedValueOnce([
				"Segíts egy bevásárlólistát",
			]);
			mockRegenerateApp.mockResolvedValue({
				ok: true,
				version: 2,
				title: "x",
				verification: { checked: false, verdict: "clean", reason: null },
			});

			await POST(
				makeEvent(
					"owner-user",
					{
						prompt: "Add a currency switch. Please answer in English.",
						conversationId: "conv-1",
					},
					{ uiLanguage: "hu" },
				),
			);

			expect(mockRegenerateApp).toHaveBeenCalledWith(
				expect.objectContaining({ language: "en" }),
			);
		});
	});
});
