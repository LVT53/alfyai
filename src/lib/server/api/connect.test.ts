import { describe, expect, it, vi } from "vitest";
import { ConnectionHttpError } from "$lib/server/services/connections/provider-http";
import {
	handleCredentialConnect,
	handleOAuthConnectStart,
	mapConnectError,
} from "./connect";

class ProviderError extends ConnectionHttpError {}

// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
const makeEvent = (body: unknown, user: unknown = { id: "user-1" }): any => ({
	request: new Request("https://app.example.com/api/connections/x/start", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
	}),
	locals: { user },
	url: new URL("https://app.example.com/api/connections/x/start"),
});

describe("mapConnectError", () => {
	const cases: Array<[string, number]> = [
		["invalid_credentials", 401],
		["invalid_token", 401],
		["invalid_config", 400],
		["request_failed", 502],
		["needs_reauth", 502],
		["connection_not_found", 502],
	];
	for (const [code, status] of cases) {
		it(`maps ${code} -> ${status}`, () => {
			expect(mapConnectError(new ProviderError("boom", code))).toBe(status);
		});
	}

	it("maps a non-coded error to 502", () => {
		expect(mapConnectError(new Error("network down"))).toBe(502);
		expect(mapConnectError("not even an error")).toBe(502);
	});

	it("honors overrides ahead of the base ladder", () => {
		expect(
			mapConnectError(new ProviderError("x", "not_configured"), {
				not_configured: 409,
			}),
		).toBe(409);
		expect(
			mapConnectError(new ProviderError("x", "connection_not_found"), {
				connection_not_found: 404,
			}),
		).toBe(404);
	});
});

describe("handleCredentialConnect", () => {
	const parse = (body: Record<string, unknown>) =>
		typeof body.token === "string" && body.token.trim()
			? { ok: true as const, value: { token: body.token.trim() } }
			: { ok: false as const, error: "token is required" };

	it("returns 401 for an anonymous caller before parsing", async () => {
		const connect = vi.fn();
		await expect(
			handleCredentialConnect({
				event: makeEvent({ token: "t" }, null),
				parse,
				connect,
				errorType: ProviderError,
				fallbackError: "failed",
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(connect).not.toHaveBeenCalled();
	});

	it("returns 400 Invalid JSON on an unparseable body", async () => {
		const res = await handleCredentialConnect({
			event: makeEvent("not json"),
			parse,
			connect: vi.fn(),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid JSON");
	});

	it("returns 400 with the parse error when validation fails", async () => {
		const connect = vi.fn();
		const res = await handleCredentialConnect({
			event: makeEvent({}),
			parse,
			connect,
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("token is required");
		expect(connect).not.toHaveBeenCalled();
	});

	it("calls connect with the parsed value and returns its result on success", async () => {
		const connect = vi.fn().mockResolvedValue({ connection: { id: "c1" } });
		const res = await handleCredentialConnect({
			event: makeEvent({ token: "  abc  " }),
			parse,
			connect,
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(200);
		expect(connect).toHaveBeenCalledWith({
			userId: "user-1",
			value: { token: "abc" },
		});
		expect((await res.json()).connection.id).toBe("c1");
	});

	it("maps a provider error's code to its status and surfaces its message", async () => {
		const res = await handleCredentialConnect({
			event: makeEvent({ token: "abc" }),
			parse,
			connect: vi
				.fn()
				.mockRejectedValue(
					new ProviderError("bad creds", "invalid_credentials"),
				),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe("bad creds");
	});

	it("falls back to a generic message + 502 for a non-provider error", async () => {
		const res = await handleCredentialConnect({
			event: makeEvent({ token: "abc" }),
			parse,
			connect: vi.fn().mockRejectedValue(new Error("network down")),
			errorType: ProviderError,
			fallbackError: "Failed to connect",
		});
		expect(res.status).toBe(502);
		expect((await res.json()).error).toBe("Failed to connect");
	});

	it("applies error status overrides", async () => {
		const res = await handleCredentialConnect({
			event: makeEvent({ token: "abc" }),
			parse,
			connect: vi
				.fn()
				.mockRejectedValue(new ProviderError("nope", "not_configured")),
			errorType: ProviderError,
			fallbackError: "failed",
			errorStatusOverrides: { not_configured: 409 },
		});
		expect(res.status).toBe(409);
	});
});

describe("handleOAuthConnectStart", () => {
	it("returns 400 when no known capabilities are supplied", async () => {
		const res = await handleOAuthConnectStart({
			event: makeEvent({ capabilities: ["bogus"] }),
			connectStart: vi.fn(),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(400);
	});

	it("maps not_configured -> 501 and other errors -> 502", async () => {
		const res501 = await handleOAuthConnectStart({
			event: makeEvent({ capabilities: ["calendar"] }),
			connectStart: vi
				.fn()
				.mockRejectedValue(new ProviderError("no", "not_configured")),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res501.status).toBe(501);

		const res502 = await handleOAuthConnectStart({
			event: makeEvent({ capabilities: ["calendar"] }),
			connectStart: vi.fn().mockRejectedValue(new Error("boom")),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res502.status).toBe(502);
	});

	it("returns the connectStart result on success", async () => {
		const res = await handleOAuthConnectStart({
			event: makeEvent({ capabilities: ["calendar"] }),
			connectStart: vi.fn().mockResolvedValue({ url: "https://consent" }),
			errorType: ProviderError,
			fallbackError: "failed",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).url).toBe("https://consent");
	});
});
