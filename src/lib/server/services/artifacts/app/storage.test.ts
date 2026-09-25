import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

// vi.mock is hoisted above these imports regardless of where it is written
// textually, so `memory` must be read lazily through a getter rather than
// captured by value.
vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact } = await import("$lib/server/services/artifacts");
const { APP_KV_LIMITS, readAppValue, writeAppValue } = await import(
	"./storage"
);
const {
	ARTIFACT_KV_KEY_MAX_CHARS,
	ARTIFACT_KV_MAX_KEYS,
	ARTIFACT_KV_TOTAL_MAX_BYTES,
	ARTIFACT_KV_VALUE_MAX_BYTES,
} = await import("$lib/server/services/artifacts/limits");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

async function createApp(
	conversationId: string | null = CONVERSATION,
	kind: "app" | "document" = "app",
) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind,
		title: "Habit tracker",
		body: "<!doctype html><title>Habits</title>",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

function kvRowCount() {
	return memory.db.select().from(schema.artifactKv).all().length;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
});

afterEach(() => {
	memory.close();
});

describe("APP_KV_LIMITS", () => {
	it("derives every field from Slice 0's limits.ts — never a restated number", () => {
		expect(APP_KV_LIMITS.maxKeys).toBe(ARTIFACT_KV_MAX_KEYS);
		expect(APP_KV_LIMITS.maxKeyLength).toBe(ARTIFACT_KV_KEY_MAX_CHARS);
		expect(APP_KV_LIMITS.maxValueBytes).toBe(ARTIFACT_KV_VALUE_MAX_BYTES);
		expect(APP_KV_LIMITS.maxTotalBytes).toBe(ARTIFACT_KV_TOTAL_MAX_BYTES);
	});
});

describe("readAppValue / writeAppValue — round trip", () => {
	it.each([
		["a string", "hello"],
		["a number", 42],
		["an object with nested arrays", { a: [1, 2, { b: [3] }] }],
		["null", null],
		["true", true],
		["an empty string", ""],
	])("round-trips %s", async (_label, value) => {
		const app = await createApp();
		await expect(
			writeAppValue({ userId: OWNER, artifactId: app.id, key: "k", value }),
		).resolves.toEqual({ ok: true });
		await expect(
			readAppValue({ userId: OWNER, artifactId: app.id, key: "k" }),
		).resolves.toEqual({ ok: true, value });
	});

	it("a missing key reads as { ok: true, value: null } — a promise of null, not a rejection", async () => {
		const app = await createApp();
		await expect(
			readAppValue({ userId: OWNER, artifactId: app.id, key: "never-set" }),
		).resolves.toEqual({ ok: true, value: null });
	});

	it("a key belonging to a different artifact is also { ok: true, value: null }, never the other app's value", async () => {
		const appA = await createApp();
		const appB = await createApp();
		await writeAppValue({
			userId: OWNER,
			artifactId: appA.id,
			key: "k",
			value: "a's value",
		});

		await expect(
			readAppValue({ userId: OWNER, artifactId: appB.id, key: "k" }),
		).resolves.toEqual({ ok: true, value: null });
	});
});

describe("readAppValue / writeAppValue — scope", () => {
	it("404-shaped not_found for another user's artifact, on both verbs", async () => {
		const app = await createApp();
		await expect(
			readAppValue({ userId: STRANGER, artifactId: app.id, key: "k" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			writeAppValue({
				userId: STRANGER,
				artifactId: app.id,
				key: "k",
				value: 1,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(kvRowCount()).toBe(0);
	});

	it("not_found for an incognito artifact read from outside its own conversation", async () => {
		const hidden = await createApp(INCOGNITO);
		await expect(
			readAppValue({ userId: OWNER, artifactId: hidden.id, key: "k" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: hidden.id,
				key: "k",
				value: 1,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
	});

	it("succeeds for the incognito artifact's own conversation, widened explicitly", async () => {
		const hidden = await createApp(INCOGNITO);
		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: hidden.id,
				key: "k",
				value: 1,
				conversationId: INCOGNITO,
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			readAppValue({
				userId: OWNER,
				artifactId: hidden.id,
				key: "k",
				conversationId: INCOGNITO,
			}),
		).resolves.toEqual({ ok: true, value: 1 });
	});

	it("not_found for a Document — an App's storage and nothing else's", async () => {
		const document = await createApp(CONVERSATION, "document");
		await expect(
			readAppValue({ userId: OWNER, artifactId: document.id, key: "k" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: document.id,
				key: "k",
				value: 1,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(kvRowCount()).toBe(0);
	});
});

describe("writeAppValue — every limit, with no row written", () => {
	it("invalid_key for an empty key", async () => {
		const app = await createApp();
		await expect(
			writeAppValue({ userId: OWNER, artifactId: app.id, key: "", value: 1 }),
		).resolves.toEqual({ ok: false, reason: "invalid_key" });
		expect(kvRowCount()).toBe(0);
	});

	it("invalid_key for a key over the length cap — the CONSTANT, never a literal", async () => {
		const app = await createApp();
		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "k".repeat(APP_KV_LIMITS.maxKeyLength + 1),
				value: 1,
			}),
		).resolves.toEqual({ ok: false, reason: "invalid_key" });
		expect(kvRowCount()).toBe(0);
	});

	it("too_large for a value whose JSON.stringify exceeds the byte cap", async () => {
		const app = await createApp();
		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "k",
				value: "x".repeat(APP_KV_LIMITS.maxValueBytes),
			}),
		).resolves.toEqual({ ok: false, reason: "too_large" });
		expect(kvRowCount()).toBe(0);
	});

	it("not_serialisable for undefined, a function, a BigInt and a cycle — never a throw", async () => {
		const app = await createApp();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;

		for (const value of [undefined, () => {}, 10n, cycle]) {
			await expect(
				writeAppValue({ userId: OWNER, artifactId: app.id, key: "k", value }),
			).resolves.toEqual({ ok: false, reason: "not_serialisable" });
		}
		expect(kvRowCount()).toBe(0);
	});

	it("too_many_keys for a NEW key once the artifact holds maxKeys — against the constant, and an existing key still updates at the cap", async () => {
		const app = await createApp();
		for (let index = 0; index < APP_KV_LIMITS.maxKeys; index += 1) {
			await expect(
				writeAppValue({
					userId: OWNER,
					artifactId: app.id,
					key: `k-${index}`,
					value: index,
				}),
			).resolves.toEqual({ ok: true });
		}

		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "one-too-many",
				value: 1,
			}),
		).resolves.toEqual({ ok: false, reason: "too_many_keys" });
		expect(kvRowCount()).toBe(APP_KV_LIMITS.maxKeys);

		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "k-0",
				value: "updated",
			}),
		).resolves.toEqual({ ok: true });
	});

	it("too_large for a total that would exceed maxTotalBytes, even though each value alone is under maxValueBytes", async () => {
		const app = await createApp();
		const atPerValueCap = "x".repeat(APP_KV_LIMITS.maxValueBytes - 2);
		await writeAppValue({
			userId: OWNER,
			artifactId: app.id,
			key: "a",
			value: atPerValueCap,
		});
		await writeAppValue({
			userId: OWNER,
			artifactId: app.id,
			key: "b",
			value: atPerValueCap,
		});

		await expect(
			writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "c",
				value: "y",
			}),
		).resolves.toEqual({ ok: false, reason: "too_large" });
		expect(kvRowCount()).toBe(2);
	});
});

describe("isolation", () => {
	it("two apps do not see each other's keys, even with the same key name", async () => {
		const appA = await createApp();
		const appB = await createApp();
		await writeAppValue({
			userId: OWNER,
			artifactId: appA.id,
			key: "shared-name",
			value: "from A",
		});
		await writeAppValue({
			userId: OWNER,
			artifactId: appB.id,
			key: "shared-name",
			value: "from B",
		});

		await expect(
			readAppValue({ userId: OWNER, artifactId: appA.id, key: "shared-name" }),
		).resolves.toEqual({ ok: true, value: "from A" });
		await expect(
			readAppValue({ userId: OWNER, artifactId: appB.id, key: "shared-name" }),
		).resolves.toEqual({ ok: true, value: "from B" });
	});
});

describe("nothing logs the value", () => {
	it("no console.* call receives the stored string during a write or a read", async () => {
		const app = await createApp();
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
		try {
			const secret = "the-users-own-private-text";
			await writeAppValue({
				userId: OWNER,
				artifactId: app.id,
				key: "k",
				value: secret,
			});
			await readAppValue({ userId: OWNER, artifactId: app.id, key: "k" });

			for (const spy of spies) {
				for (const call of spy.mock.calls) {
					expect(JSON.stringify(call)).not.toContain(secret);
				}
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
