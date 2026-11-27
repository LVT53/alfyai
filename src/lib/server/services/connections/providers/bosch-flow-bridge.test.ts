import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	acceptBoschUpload,
	loadBoschForQuestion,
	pairBoschBridge,
	pollBoschQuestion,
	readBoschSnapshot,
} from "./bosch-flow-bridge";

let sqlite: Database.Database;
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
beforeEach(() => {
	sqlite = new Database(":memory:");
	const orm = drizzle(sqlite, { schema });
	migrate(orm, { migrationsFolder: "./drizzle" });
	for (const id of ["one", "two"]) {
		orm
			.insert(schema.users)
			.values({
				id,
				email: `${id}@example.org`,
				passwordHash: "unused",
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
	}
});
afterEach(() => sqlite.close());

const bikeData = {
	bikes: [{ id: "bike", name: "Cube" }],
	rides: [],
	complete: true,
};
describe("personal Bosch rider pairing", () => {
	it("isolates rider snapshots and rejects keys rotated or mixed between riders", async () => {
		const first = await pairBoschBridge("one");
		const second = await pairBoschBridge("two");
		expect(
			await acceptBoschUpload(first.pairingToken, async () => bikeData),
		).toBe(204);
		expect(await readBoschSnapshot("one", first.connectionId)).toMatchObject(
			bikeData,
		);
		expect(await readBoschSnapshot("two", first.connectionId)).toBeNull();
		const mixed = second.pairingToken
			.split(".")
			.slice(0, 2)
			.concat(first.pairingToken.split(".")[2])
			.join(".");
		const unused = vi.fn();
		expect(await acceptBoschUpload(mixed, unused)).toBe(401);
		const rotated = await pairBoschBridge("one");
		expect(await acceptBoschUpload(first.pairingToken, unused)).toBe(401);
		expect(unused).not.toHaveBeenCalled();
		expect(rotated.connectionId).toBe(first.connectionId);
		expect(await readBoschSnapshot("one", rotated.connectionId)).toMatchObject(
			bikeData,
		);
	});
	it("a question triggers a fresh read only on its rider's helper", async () => {
		const first = await pairBoschBridge("one");
		const second = await pairBoschBridge("two");
		expect(await loadBoschForQuestion("one", first.connectionId)).toEqual({
			snapshot: null,
			fresh: false,
		});
		expect(await pollBoschQuestion(first.pairingToken, null)).toMatchObject({
			requestId: null,
		});
		const answer = loadBoschForQuestion("one", first.connectionId);
		let id: string | null = null;
		await vi.waitFor(async () => {
			id =
				(await pollBoschQuestion(first.pairingToken, null))?.requestId ?? null;
			expect(id).toBeTruthy();
		});
		expect(await pollBoschQuestion(second.pairingToken, null)).toMatchObject({
			requestId: null,
		});
		expect(
			await acceptBoschUpload(second.pairingToken, async () => bikeData, id),
		).toBe(409);
		expect(
			await acceptBoschUpload(first.pairingToken, async () => bikeData, id),
		).toBe(204);
		expect(await answer).toMatchObject({ fresh: true, snapshot: bikeData });
		expect(await pollBoschQuestion(first.pairingToken, null)).toMatchObject({
			requestId: null,
		});
		expect(
			await acceptBoschUpload(first.pairingToken, async () => bikeData, id),
		).toBe(409);
	});
	it("discards an in-flight upload if the rider replaces the key during transfer", async () => {
		const pair = await pairBoschBridge("one");
		const result = await acceptBoschUpload(pair.pairingToken, async () => {
			await pairBoschBridge("one");
			return bikeData;
		});
		expect(result).toBe(409);
		expect(await readBoschSnapshot("one", pair.connectionId)).toBeNull();
	});
	it("rejects provider credentials or location data instead of storing them", async () => {
		const pair = await pairBoschBridge("one");
		expect(
			await acceptBoschUpload(pair.pairingToken, async () => ({
				...bikeData,
				refreshToken: "unused",
			})),
		).toBe(400);
		expect(
			await acceptBoschUpload(pair.pairingToken, async () => ({
				...bikeData,
				bikes: [{ id: "bike", name: "Cube", lat: 0 }],
			})),
		).toBe(400);
		expect(await readBoschSnapshot("one", pair.connectionId)).toBeNull();
	});
});
