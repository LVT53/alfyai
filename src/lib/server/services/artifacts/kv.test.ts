import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, deleteKv, getKv, listKv, setKv } = await import(
	"./index"
);
const {
	ARTIFACT_KV_KEY_MAX_CHARS,
	ARTIFACT_KV_MAX_KEYS,
	ARTIFACT_KV_VALUE_MAX_BYTES,
} = await import("./limits");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

async function createApp(
	conversationId = CONVERSATION,
	kind: "app" | "document" = "app",
) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind,
		title: "Trip cost splitter",
		body: "<!doctype html><title>Split</title>",
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

describe("the key-value accessors", () => {
	it("round-trips a value, updates an existing key in place, lists keys ascending and deletes", async () => {
		const app = await createApp();
		const base = { userId: OWNER, artifactId: app.id };

		await expect(
			setKv({ ...base, key: "expenses", valueJson: "[42]" }),
		).resolves.toBe(true);
		await expect(getKv({ ...base, key: "expenses" })).resolves.toBe("[42]");

		await expect(
			setKv({ ...base, key: "expenses", valueJson: "[42,7]" }),
		).resolves.toBe(true);
		await expect(getKv({ ...base, key: "expenses" })).resolves.toBe("[42,7]");
		expect(kvRowCount()).toBe(1);

		await setKv({ ...base, key: "people", valueJson: '["Anna","Bence"]' });
		await setKv({ ...base, key: "currency", valueJson: '"EUR"' });
		const rows = await listKv(base);
		expect(rows.map((row) => row.key)).toEqual([
			"currency",
			"expenses",
			"people",
		]);
		expect(rows[1]).toEqual({
			key: "expenses",
			valueJson: "[42,7]",
			updatedAt: expect.any(Number),
		});

		await expect(deleteKv({ ...base, key: "people" })).resolves.toBe(true);
		await expect(getKv({ ...base, key: "people" })).resolves.toBeNull();
		await expect(deleteKv({ ...base, key: "people" })).resolves.toBe(false);
	});

	// A key-value row has no user column: this is the test that makes that
	// safe. Every accessor resolves the artifact through the scoped read first.
	it("answers its empty value for another user's artifact and for an incognito App read from outside", async () => {
		const app = await createApp();
		await setKv({
			userId: OWNER,
			artifactId: app.id,
			key: "expenses",
			valueJson: "[42]",
		});
		const hidden = await createApp(INCOGNITO);
		await expect(
			setKv({
				userId: OWNER,
				artifactId: hidden.id,
				key: "expenses",
				valueJson: "[1]",
				conversationId: INCOGNITO,
			}),
		).resolves.toBe(true);

		for (const [userId, artifactId] of [
			[STRANGER, app.id],
			[OWNER, hidden.id],
		] as const) {
			await expect(
				getKv({ userId, artifactId, key: "expenses" }),
			).resolves.toBeNull();
			await expect(
				setKv({ userId, artifactId, key: "expenses", valueJson: "[666]" }),
			).resolves.toBe(false);
			await expect(listKv({ userId, artifactId })).resolves.toEqual([]);
			await expect(
				deleteKv({ userId, artifactId, key: "expenses" }),
			).resolves.toBe(false);
		}

		await expect(
			getKv({ userId: OWNER, artifactId: app.id, key: "expenses" }),
		).resolves.toBe("[42]");
		await expect(
			getKv({
				userId: OWNER,
				artifactId: hidden.id,
				key: "expenses",
				includeIncognito: true,
			}),
		).resolves.toBe("[1]");
	});

	it("is an App's storage and nothing else's", async () => {
		const document = await createApp(CONVERSATION, "document");
		const base = { userId: OWNER, artifactId: document.id };

		await expect(setKv({ ...base, key: "k", valueJson: "1" })).resolves.toBe(
			false,
		);
		await expect(getKv({ ...base, key: "k" })).resolves.toBeNull();
		await expect(listKv(base)).resolves.toEqual([]);
		expect(kvRowCount()).toBe(0);
	});

	it("refuses — false, not a throw — a value over the byte cap, an over-long or empty key, and a value that is not JSON", async () => {
		const app = await createApp();
		const base = { userId: OWNER, artifactId: app.id };

		await expect(
			setKv({
				...base,
				key: "big",
				valueJson: JSON.stringify("x".repeat(ARTIFACT_KV_VALUE_MAX_BYTES)),
			}),
		).resolves.toBe(false);
		await expect(
			setKv({
				...base,
				key: "k".repeat(ARTIFACT_KV_KEY_MAX_CHARS + 1),
				valueJson: "1",
			}),
		).resolves.toBe(false);
		await expect(setKv({ ...base, key: "", valueJson: "1" })).resolves.toBe(
			false,
		);
		await expect(
			setKv({ ...base, key: "k", valueJson: "{not json" }),
		).resolves.toBe(false);
		expect(kvRowCount()).toBe(0);
	});

	it("refuses a new key past the key cap, and still updates an existing key at the cap", async () => {
		const app = await createApp();
		const base = { userId: OWNER, artifactId: app.id };
		for (let index = 0; index < ARTIFACT_KV_MAX_KEYS; index += 1) {
			await expect(
				setKv({ ...base, key: `key-${index}`, valueJson: `${index}` }),
			).resolves.toBe(true);
		}

		await expect(
			setKv({ ...base, key: "one-too-many", valueJson: "1" }),
		).resolves.toBe(false);
		await expect(
			setKv({ ...base, key: "key-0", valueJson: '"updated"' }),
		).resolves.toBe(true);
		expect(kvRowCount()).toBe(ARTIFACT_KV_MAX_KEYS);
		await expect(getKv({ ...base, key: "key-0" })).resolves.toBe('"updated"');
	});
});

// Concurrency: setKv's existence check, cap check and write all happen inside
// one db.transaction() call, which better-sqlite3 runs to completion before
// yielding back to the event loop — so two Promise.all-launched writers race
// only up to the transaction boundary, never inside it.
describe("setKv concurrency", () => {
	it("leaves exactly one row when two writers race to create the same new key", async () => {
		const app = await createApp();
		const base = { userId: OWNER, artifactId: app.id };

		const results = await Promise.all([
			setKv({ ...base, key: "expenses", valueJson: "[1]" }),
			setKv({ ...base, key: "expenses", valueJson: "[2]" }),
		]);

		expect(results).toEqual([true, true]);
		expect(kvRowCount()).toBe(1);
	});

	it("admits exactly one of two new keys racing for the last slot under the cap", async () => {
		const app = await createApp();
		const base = { userId: OWNER, artifactId: app.id };
		for (let index = 0; index < ARTIFACT_KV_MAX_KEYS - 1; index += 1) {
			await setKv({ ...base, key: `key-${index}`, valueJson: `${index}` });
		}
		expect(kvRowCount()).toBe(ARTIFACT_KV_MAX_KEYS - 1);

		const [a, b] = await Promise.all([
			setKv({ ...base, key: "race-a", valueJson: "1" }),
			setKv({ ...base, key: "race-b", valueJson: "2" }),
		]);

		expect([a, b].filter(Boolean)).toHaveLength(1);
		expect(kvRowCount()).toBe(ARTIFACT_KV_MAX_KEYS);
	});
});
