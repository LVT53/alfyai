import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
} from "$lib/server/services/two-step";
import { listManagedUsers } from "./user-admin";

// R18: the admin Users page reads every account's two-step state from grouped
// queries, never one call per row. This proves the summary carries it (the
// query count is held by the shape of `listTwoStepStatuses`, not asserted
// here) and that an unconfirmed factor still reads as Off.

const userIds: string[] = [];

async function createUser(): Promise<{ id: string; email: string }> {
	const id = randomUUID();
	const email = `${id}@example.com`;
	userIds.push(id);
	await db.insert(users).values({ id, email, passwordHash: "hash" });
	return { id, email };
}

async function enable(userId: string, email: string) {
	const now = new Date();
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) throw new Error("setup refused");
	const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
	const confirmed = await confirmTwoStepSetup(
		userId,
		generateHOTP(secret, BigInt(Math.floor(now.getTime() / 30_000)), 6),
		now,
		null,
	);
	if (!confirmed.ok) throw new Error("confirm refused");
	return now;
}

afterEach(async () => {
	for (const id of userIds) {
		await db.delete(users).where(eq(users.id, id));
	}
	userIds.length = 0;
});

describe("the admin user list's two-step fields", () => {
	it("carries enabled, since and the codes left, and Off for the rest", async () => {
		const on = await createUser();
		const unconfirmed = await createUser();
		const off = await createUser();
		const since = await enable(on.id, on.email);
		await beginTwoStepSetup(unconfirmed.id, unconfirmed.email);

		const rows = await listManagedUsers();
		const byId = new Map(rows.map((row) => [row.id, row]));

		const onRow = byId.get(on.id);
		expect(onRow?.twoStepEnabled).toBe(true);
		expect(onRow?.twoStepSince).toBe(Math.floor(since.getTime() / 1000) * 1000);
		expect(onRow?.backupCodesLeft).toBe(10);

		expect(byId.get(unconfirmed.id)?.twoStepEnabled).toBe(false);
		expect(byId.get(unconfirmed.id)?.twoStepSince).toBeNull();

		expect(byId.get(off.id)?.twoStepEnabled).toBe(false);
		expect(byId.get(off.id)?.backupCodesLeft).toBe(0);
	});
});
