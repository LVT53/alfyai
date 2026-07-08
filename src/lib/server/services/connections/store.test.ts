import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-connections-store-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

const SECRET_KEYS = ["secretCiphertext", "secretIv", "secretAuthTag"] as const;

describe("connections store", () => {
	it("createConnection then getConnection returns the public DTO with no secret fields", async () => {
		const { createConnection, getConnection } = await import("./store");
		seedUser("userA");

		const created = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal Google",
			accountIdentifier: "me@gmail.com",
			capabilities: ["email", "calendar"],
			oauthScopes: ["scope-a"],
		});

		expect(created.userId).toBe("userA");
		expect(created.provider).toBe("google");
		expect(created.label).toBe("Personal Google");
		expect(created.accountIdentifier).toBe("me@gmail.com");
		expect(created.status).toBe("disconnected");
		expect(created.defaultOn).toBe(false);
		expect(created.allowWrites).toBe(false);
		expect(created.capabilities).toEqual(["email", "calendar"]);
		expect(created.writeAllowlist).toEqual([]);
		expect(created.oauthScopes).toEqual(["scope-a"]);
		expect(created.hasSecret).toBe(false);
		for (const key of SECRET_KEYS) {
			expect(key in created).toBe(false);
		}

		const fetched = await getConnection("userA", created.id);
		expect(fetched).toEqual(created);
		for (const key of SECRET_KEYS) {
			expect(fetched && key in fetched).toBe(false);
		}
	});

	it("hasSecret reflects whether a secret was set at creation", async () => {
		const { createConnection } = await import("./store");
		seedUser("userA");

		const withSecret = await createConnection({
			userId: "userA",
			provider: "imap",
			label: "Work email",
			secret: "super-secret-password",
		});
		expect(withSecret.hasSecret).toBe(true);
		for (const key of SECRET_KEYS) {
			expect(key in withSecret).toBe(false);
		}
	});

	describe("user isolation", () => {
		async function seedTwoUsersWithAConnection() {
			const { createConnection } = await import("./store");
			seedUser("userA");
			seedUser("userB");
			const conn = await createConnection({
				userId: "userA",
				provider: "nextcloud",
				label: "A's Nextcloud",
			});
			return conn;
		}

		it("getConnection(B, idOfA) returns null", async () => {
			const { getConnection } = await import("./store");
			const conn = await seedTwoUsersWithAConnection();
			expect(await getConnection("userB", conn.id)).toBeNull();
		});

		it("updateConnection(B, idOfA, ...) returns null and does not modify A's row", async () => {
			const { updateConnection, getConnection } = await import("./store");
			const conn = await seedTwoUsersWithAConnection();
			const result = await updateConnection("userB", conn.id, {
				label: "hijacked",
			});
			expect(result).toBeNull();
			const stillA = await getConnection("userA", conn.id);
			expect(stillA?.label).toBe("A's Nextcloud");
		});

		it("deleteConnection(B, idOfA) returns false and A's row still exists", async () => {
			const { deleteConnection, getConnection } = await import("./store");
			const conn = await seedTwoUsersWithAConnection();
			expect(await deleteConnection("userB", conn.id)).toBe(false);
			expect(await getConnection("userA", conn.id)).not.toBeNull();
		});

		it("listConnectionsForUser(B) excludes A's connections", async () => {
			const { listConnectionsForUser, createConnection } = await import(
				"./store"
			);
			await seedTwoUsersWithAConnection();
			await createConnection({
				userId: "userB",
				provider: "plex",
				label: "B's Plex",
			});

			const listA = await listConnectionsForUser("userA");
			const listB = await listConnectionsForUser("userB");
			expect(listA).toHaveLength(1);
			expect(listA[0]?.label).toBe("A's Nextcloud");
			expect(listB).toHaveLength(1);
			expect(listB[0]?.label).toBe("B's Plex");
		});

		it("setAllowWrites/setDefaultOn/setEnabledCapabilities only affect the target user's row", async () => {
			const {
				setAllowWrites,
				setDefaultOn,
				setEnabledCapabilities,
				getConnection,
			} = await import("./store");
			const conn = await seedTwoUsersWithAConnection();

			expect(await setAllowWrites("userB", conn.id, true)).toBeNull();
			expect(await setDefaultOn("userB", conn.id, true)).toBeNull();
			expect(await setEnabledCapabilities("userB", conn.id, ["x"])).toBeNull();

			const stillA = await getConnection("userA", conn.id);
			expect(stillA?.allowWrites).toBe(false);
			expect(stillA?.defaultOn).toBe(false);
			expect(stillA?.capabilities).toEqual([]);
		});
	});

	it("setConnectionSecret then getConnectionSecret round-trips the plaintext, and stored columns are ciphertext", async () => {
		const { createConnection, setConnectionSecret, getConnectionSecret } =
			await import("./store");
		const { db } = await import("$lib/server/db");
		const { userConnections } = await import("$lib/server/db/schema");
		const { eq } = await import("drizzle-orm");
		seedUser("userA");

		const conn = await createConnection({
			userId: "userA",
			provider: "imap",
			label: "Work email",
		});

		const plaintext = "hunter2-refresh-token";
		const ok = await setConnectionSecret("userA", conn.id, plaintext);
		expect(ok).toBe(true);

		const decrypted = await getConnectionSecret("userA", conn.id);
		expect(decrypted).toBe(plaintext);

		const [row] = await db
			.select()
			.from(userConnections)
			.where(eq(userConnections.id, conn.id));
		expect(row?.secretCiphertext).toBeTruthy();
		expect(row?.secretCiphertext).not.toBe(plaintext);
		expect(row?.secretIv).toBeTruthy();
		expect(row?.secretAuthTag).toBeTruthy();
	});

	it("setConnectionSecret returns false and getConnectionSecret returns null for another user's connection", async () => {
		const { createConnection, setConnectionSecret, getConnectionSecret } =
			await import("./store");
		seedUser("userA");
		seedUser("userB");
		const conn = await createConnection({
			userId: "userA",
			provider: "imap",
			label: "Work email",
		});

		expect(await setConnectionSecret("userB", conn.id, "nope")).toBe(false);
		expect(await getConnectionSecret("userB", conn.id)).toBeNull();
	});

	it("getConnectionSecret returns null when no secret has been set", async () => {
		const { createConnection, getConnectionSecret } = await import("./store");
		seedUser("userA");
		const conn = await createConnection({
			userId: "userA",
			provider: "imap",
			label: "Work email",
		});
		expect(await getConnectionSecret("userA", conn.id)).toBeNull();
	});

	it("deleteConnection removes the row entirely (and thus the secret)", async () => {
		const {
			createConnection,
			deleteConnection,
			getConnection,
			getConnectionSecret,
		} = await import("./store");
		seedUser("userA");
		const conn = await createConnection({
			userId: "userA",
			provider: "imap",
			label: "Work email",
			secret: "s3cret",
		});

		expect(await deleteConnection("userA", conn.id)).toBe(true);
		expect(await getConnection("userA", conn.id)).toBeNull();
		expect(await getConnectionSecret("userA", conn.id)).toBeNull();
	});

	it("updateConnection patches fields, parses/stringifies JSON arrays, and bumps updatedAt", async () => {
		const { createConnection, updateConnection } = await import("./store");
		seedUser("userA");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal",
		});

		await new Promise((resolve) => setTimeout(resolve, 1100));

		const updated = await updateConnection("userA", conn.id, {
			label: "Renamed",
			status: "needs_reauth",
			statusDetail: "token expired",
			writeAllowlist: ["calendar", "contacts"],
			capabilities: ["email"],
			oauthScopes: ["scope-b"],
			tokenExpiresAt: 1_800_000_000,
		});

		expect(updated?.label).toBe("Renamed");
		expect(updated?.status).toBe("needs_reauth");
		expect(updated?.statusDetail).toBe("token expired");
		expect(updated?.writeAllowlist).toEqual(["calendar", "contacts"]);
		expect(updated?.capabilities).toEqual(["email"]);
		expect(updated?.oauthScopes).toEqual(["scope-b"]);
		expect(updated?.tokenExpiresAt).toBe(1_800_000_000);
		expect(updated?.updatedAt).toBeGreaterThan(conn.updatedAt);
	});

	it("setAllowWrites/setDefaultOn/setEnabledCapabilities mutate the target row and bump updatedAt", async () => {
		const {
			createConnection,
			setAllowWrites,
			setDefaultOn,
			setEnabledCapabilities,
		} = await import("./store");
		seedUser("userA");
		const conn = await createConnection({
			userId: "userA",
			provider: "google",
			label: "Personal",
		});

		await new Promise((resolve) => setTimeout(resolve, 1100));

		const afterWrites = await setAllowWrites("userA", conn.id, true);
		expect(afterWrites?.allowWrites).toBe(true);
		expect(afterWrites?.updatedAt).toBeGreaterThan(conn.updatedAt);

		const afterDefault = await setDefaultOn("userA", conn.id, true);
		expect(afterDefault?.defaultOn).toBe(true);

		const afterCaps = await setEnabledCapabilities("userA", conn.id, [
			"email",
			"calendar",
		]);
		expect(afterCaps?.capabilities).toEqual(["email", "calendar"]);
	});

	it("getConnection/updateConnection/deleteConnection return null/false for a nonexistent id", async () => {
		const { getConnection, updateConnection, deleteConnection } = await import(
			"./store"
		);
		seedUser("userA");
		expect(await getConnection("userA", "ghost")).toBeNull();
		expect(await updateConnection("userA", "ghost", { label: "x" })).toBeNull();
		expect(await deleteConnection("userA", "ghost")).toBe(false);
	});
});
