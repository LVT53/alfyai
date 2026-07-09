import { describe, expect, it, vi } from "vitest";
import {
	cancelWrite,
	confirmWrite,
	fetchConversationPendingWrites,
} from "./connection-writes";

describe("connection-writes client API", () => {
	it("confirmWrite posts to the confirm endpoint and returns {ok, alreadyExecuted, etag}", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, alreadyExecuted: false, etag: '"e1"' }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(confirmWrite("pw-1", fetchMock)).resolves.toEqual({
			ok: true,
			alreadyExecuted: false,
			etag: '"e1"',
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/writes/pw-1/confirm",
			{ method: "POST" },
		);
	});

	it("confirmWrite surfaces an alreadyExecuted:true response as confirmed", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, alreadyExecuted: true, etag: null }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(confirmWrite("pw-1", fetchMock)).resolves.toEqual({
			ok: true,
			alreadyExecuted: true,
			etag: null,
		});
	});

	it("confirmWrite throws with the server's error reason on failure", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "cancelled" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(confirmWrite("pw-1", fetchMock)).rejects.toThrow("cancelled");
	});

	it("cancelWrite posts to the cancel endpoint and returns {ok, status:'cancelled'}", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(cancelWrite("pw-1", fetchMock)).resolves.toEqual({
			ok: true,
			status: "cancelled",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/writes/pw-1/cancel",
			{ method: "POST" },
		);
	});

	it("cancelWrite throws with the server's error reason on failure", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "already_executed" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(cancelWrite("pw-1", fetchMock)).rejects.toThrow(
			"already_executed",
		);
	});

	it("fetchConversationPendingWrites GETs the conversation-scoped endpoint and returns the list", async () => {
		const preview = {
			title: "Save note.txt",
			detail: "files.put — /AlfyAI/note.txt",
			reversible: true,
			destructive: false,
			withinAllowlist: true,
			warnings: [],
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						pendingWrites: [
							{
								id: "pw-1",
								assistantMessageId: null,
								conversationId: "conv-1",
								status: "pending",
								preview,
								provider: "nextcloud",
								createdAt: 1700000000,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const result = await fetchConversationPendingWrites("conv-1", fetchMock);
		expect(result).toEqual([
			{
				id: "pw-1",
				assistantMessageId: null,
				conversationId: "conv-1",
				status: "pending",
				preview,
				provider: "nextcloud",
				createdAt: 1700000000,
			},
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/pending-writes",
		);
	});

	it("fetchConversationPendingWrites returns [] when the response has no pendingWrites array", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(
			fetchConversationPendingWrites("conv-1", fetchMock),
		).resolves.toEqual([]);
	});
});
