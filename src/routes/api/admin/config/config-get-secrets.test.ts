// `GET /api/admin/config` returns three views of the same table, and two of
// them were masked.
//
// `currentValues` and `envDefaults` both go through
// `getResolvedAdminConfigValues`, which masks `MINERU_API_KEY` to `[set]` —
// with a comment saying it deliberately does not copy the older keys' habit of
// answering in cleartext. `overrides` returned `admin_config` verbatim, so it
// handed back every one of them, the new key included. Nothing in the System
// screen reads those values (a secret row renders "Set · last changed <date>"
// from `overrideMeta`), so the only thing the raw field did was leak.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({ requireAdmin: vi.fn() }));

let rows: Array<{
	key: string;
	value: string;
	updatedAt: Date;
	updatedBy: string;
}> = [];

vi.mock("$lib/server/db", () => ({
	db: { select: () => ({ from: () => Promise.resolve(rows) }) },
}));

vi.mock("drizzle-orm", () => ({
	eq: (_column: unknown, value: string) => ({ key: value }),
}));

vi.mock("$lib/server/db/schema", () => ({ adminConfig: { key: "key" } }));

vi.mock("$lib/server/prompts", () => ({
	normalizeSystemPromptReference: (value: string) => value,
}));

vi.mock("$lib/server/config-store", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/config-store")
	>("$lib/server/config-store");
	return {
		...actual,
		refreshConfig: vi.fn(async () => {}),
		getEnvDefaults: () => ({}),
		getResolvedAdminConfigValues: () => ({}),
		getAtlasOverviewMaxOutputTokens: () => 0,
		getAtlasInDepthMaxOutputTokens: () => 0,
		getAtlasExhaustiveMaxOutputTokens: () => 0,
		getAtlasMaxWriterPromptChars: () => 0,
	};
});

import { GET } from "./+server";

type RouteEvent = Parameters<typeof GET>[0];

function makeEvent(): RouteEvent {
	return {
		request: new Request("http://localhost/api/admin/config"),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/config"),
		route: { id: "/api/admin/config" },
	} as RouteEvent;
}

function row(key: string, value: string) {
	return { key, value, updatedAt: new Date(0), updatedBy: "admin-1" };
}

beforeEach(() => {
	rows = [];
});

describe("GET /api/admin/config", () => {
	it("never returns a stored credential in cleartext", async () => {
		rows = [
			row("MINERU_API_KEY", "sk-mineru-super-secret"),
			row("MODEL_1_API_KEY", "sk-model-super-secret"),
			row("GOOGLE_OAUTH_CLIENT_SECRET", "goog-super-secret"),
			row("VAPID_PRIVATE_KEY", "vapid-super-secret"),
			row("OWNTRACKS_PASS", "pass-super-secret"),
		];

		const body = (await (await GET(makeEvent())).json()) as {
			overrides: Record<string, string>;
		};

		const serialized = JSON.stringify(body);
		for (const stored of rows) {
			expect(serialized).not.toContain(stored.value);
			expect(body.overrides[stored.key]).toBe("[set]");
		}
	});

	it("still returns non-secret overrides verbatim", async () => {
		// Masking is per key, not a blanket redaction: the Advanced page shows
		// and edits these, and an admin who cannot read the current value cannot
		// tell what they are changing.
		rows = [
			row("MINERU_JOB_TIMEOUT_MS", "600000"),
			row("MINERU_DEFAULT_TIER", "basic"),
			row("MINERU_API_URL", "http://mineru.internal:8001"),
		];

		const body = (await (await GET(makeEvent())).json()) as {
			overrides: Record<string, string>;
		};
		expect(body.overrides).toEqual({
			MINERU_JOB_TIMEOUT_MS: "600000",
			MINERU_DEFAULT_TIER: "basic",
			MINERU_API_URL: "http://mineru.internal:8001",
		});
	});

	it("leaves an empty secret row empty rather than claiming it is set", async () => {
		rows = [row("MINERU_API_KEY", "")];
		const body = (await (await GET(makeEvent())).json()) as {
			overrides: Record<string, string>;
		};
		expect(body.overrides.MINERU_API_KEY).toBe("");
	});

	it("still reports when each override was written, which is what the UI reads", async () => {
		rows = [row("MINERU_API_KEY", "sk-mineru-super-secret")];
		const body = (await (await GET(makeEvent())).json()) as {
			overrideMeta: Record<string, { updatedAt: string; updatedBy: string }>;
		};
		expect(body.overrideMeta.MINERU_API_KEY.updatedBy).toBe("admin-1");
		expect(body.overrideMeta.MINERU_API_KEY.updatedAt).toBe(
			new Date(0).toISOString(),
		);
	});
});
