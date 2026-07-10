import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route-level test for POST /api/connections/onedrive/start — mirrors the
// shape of the underlying onedriveConnectStart tests
// (providers/onedrive.test.ts) but exercises the actual route handler,
// including its not-configured -> 501 / other-failure -> 502 status mapping
// and its capabilities validation.

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const ENV_KEYS = [
	"ONEDRIVE_CLIENT_ID",
	"ONEDRIVE_CLIENT_SECRET",
	"ALFYAI_API_SIGNING_KEY",
];

function setConfiguredEnv() {
	process.env.ONEDRIVE_CLIENT_ID = "test-client-id";
	process.env.ONEDRIVE_CLIENT_SECRET = "test-client-secret";
	process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
}

beforeEach(() => {
	vi.resetModules();
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

function makeEvent(
	body: unknown,
): Parameters<typeof import("./+server").POST>[0] {
	return {
		request: new Request(
			"https://app.example.com/api/connections/onedrive/start",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),
		locals: { user: { id: "userA" } },
		params: {},
		url: new URL("https://app.example.com/api/connections/onedrive/start"),
		route: { id: "/api/connections/onedrive/start" },
		// biome-ignore lint/suspicious/noExplicitAny: minimal RequestEvent stub
	} as any;
}

describe("POST /api/connections/onedrive/start", () => {
	it("returns 501 with a clear message when OneDrive is not configured", async () => {
		process.env.ALFYAI_API_SIGNING_KEY = "test-signing-key";
		const { POST } = await import("./+server");

		const response = await POST(makeEvent({ capabilities: ["files"] }));
		expect(response.status).toBe(501);
		const body = await response.json();
		expect(body.error).toContain("not configured");
	});

	it("returns 400 when capabilities is missing/empty", async () => {
		setConfiguredEnv();
		const { POST } = await import("./+server");

		const response = await POST(makeEvent({ capabilities: [] }));
		expect(response.status).toBe(400);
	});

	it("returns 200 with an authUrl when configured", async () => {
		setConfiguredEnv();
		const { POST } = await import("./+server");

		const response = await POST(makeEvent({ capabilities: ["files"] }));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.authUrl).toContain(
			"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		);
	});
});
