import { describe, expect, it, vi } from "vitest";
import {
	SESSION_EXPIRED_CODE,
	SESSION_EXPIRED_HEADER,
	SESSION_EXPIRED_MESSAGE,
} from "$lib/session-expiry";
import {
	clearSessionExpiry,
	isSessionExpired,
	markSessionExpired,
} from "$lib/stores/session";
import { ApiError, requestJson, requestResponse, requestVoid } from "./http";

function gateRefusal(): Response {
	return new Response(
		JSON.stringify({
			error: SESSION_EXPIRED_MESSAGE,
			code: SESSION_EXPIRED_CODE,
		}),
		{
			status: 401,
			headers: {
				"Content-Type": "application/json",
				[SESSION_EXPIRED_HEADER]: "1",
			},
		},
	);
}

describe("requestJson session handling", () => {
	it("raises the session row when the gate refuses the call", async () => {
		clearSessionExpiry();
		const fetchImpl = vi.fn(async () => gateRefusal());

		await expect(
			requestJson("/api/conversations", undefined, "failed", fetchImpl),
		).rejects.toBeInstanceOf(ApiError);

		expect(isSessionExpired()).toBe(true);
	});

	it("carries the gate's code to the caller", async () => {
		clearSessionExpiry();
		const fetchImpl = vi.fn(async () => gateRefusal());

		const error = await requestJson(
			"/api/conversations",
			undefined,
			"failed",
			fetchImpl,
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(401);
		expect((error as ApiError).code).toBe(SESSION_EXPIRED_CODE);
	});

	it("lowers the row again once a call succeeds", async () => {
		markSessionExpired();
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await requestJson("/api/conversations", undefined, "failed", fetchImpl);

		expect(isSessionExpired()).toBe(false);
	});

	it("covers the void and raw-response helpers too", async () => {
		clearSessionExpiry();
		await requestVoid(
			"/api/conversations/x",
			{ method: "DELETE" },
			"failed",
			vi.fn(async () => gateRefusal()),
		).catch(() => undefined);
		expect(isSessionExpired()).toBe(true);

		clearSessionExpiry();
		await requestResponse(
			"/api/knowledge/x/download",
			undefined,
			vi.fn(async () => gateRefusal()),
		);
		expect(isSessionExpired()).toBe(true);
	});

	it("leaves the row alone when a password is refused", async () => {
		clearSessionExpiry();
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "Invalid email or password" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await requestJson(
			"/api/auth/login",
			{ method: "POST" },
			"failed",
			fetchImpl,
		).catch(() => undefined);

		expect(isSessionExpired()).toBe(false);
	});
});
