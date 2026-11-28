import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { resolveActiveCapabilities } from "../resolve";
import { updateConnection } from "../store";
import {
	acceptBoschUpload,
	listBoschBikesForNaming,
	loadBoschDetailForQuestion,
	loadBoschForQuestion,
	nameBoschBike,
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
	it("keeps labels rider-scoped across refresh, uses exact bike IDs on rides and restores Bosch names when cleared", async () => {
		const one = await pairBoschBridge("one");
		const two = await pairBoschBridge("two");
		const bikes = [
			{ id: "b1", name: "Provider" },
			{ id: "b2", name: null },
			{ id: null, name: null },
		];
		const rides = [
			{
				id: "ride1",
				bikeId: "b1",
				startTime: "2026-11-01T00:00:00Z",
				endTime: null,
				distanceMeters: null,
			},
		];
		const upload = async () => ({ bikes, rides, complete: true });
		await acceptBoschUpload(one.pairingToken, upload);
		await acceptBoschUpload(two.pairingToken, upload);
		expect(await nameBoschBike("one", "missing", "Ghost")).toBe(false);
		expect(
			await Promise.all([
				nameBoschBike("one", "b1", "Cube"),
				nameBoschBike("one", "b2", "Town bike"),
			]),
		).toEqual([true, true]);
		await acceptBoschUpload(one.pairingToken, upload);
		expect(await listBoschBikesForNaming("one")).toEqual([
			{ id: "b1", name: "Cube" },
			{ id: "b2", name: "Town bike" },
		]);
		expect(await listBoschBikesForNaming("two")).toEqual([
			{ id: "b1", name: null },
			{ id: "b2", name: null },
		]);
		expect(
			(await loadBoschForQuestion("one", one.connectionId)).snapshot,
		).toMatchObject({
			bikes: [{ name: "Cube" }, { name: "Town bike" }, { name: null }],
			rides: [{ bikeName: "Cube" }],
		});
		expect(await nameBoschBike("one", "b1", "")).toBe(true);
		expect(
			(await readBoschSnapshot("one", one.connectionId))?.bikes[0].name,
		).toBe("Provider");
	});
	it("offers a new helper only after the rider sends data or enables questions, preserving explicit choices", async () => {
		const pair = await pairBoschBridge("one");
		expect(await resolveActiveCapabilities("one")).toEqual(new Set());
		expect(await resolveActiveCapabilities("one", ["cycling"])).toEqual(
			new Set(),
		);
		await acceptBoschUpload(pair.pairingToken, async () => bikeData);
		expect(await resolveActiveCapabilities("one")).toEqual(
			new Set(["cycling"]),
		);
		await updateConnection("one", pair.connectionId, { defaultOn: false });
		const renewed = await pairBoschBridge("one");
		await pollBoschQuestion(renewed.pairingToken, null);
		expect(await resolveActiveCapabilities("one")).toEqual(new Set());
		const second = await pairBoschBridge("two");
		await pollBoschQuestion(second.pairingToken, null);
		expect(await resolveActiveCapabilities("two")).toEqual(
			new Set(["cycling"]),
		);
	});
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
	it("negotiates a bikes-only read and invalidates a cached summary after a sharing change", async () => {
		const pair = await pairBoschBridge("one");
		await acceptBoschUpload(pair.pairingToken, async () => bikeData);
		const poll = () =>
			pollBoschQuestion(pair.pairingToken, null, "2", "", null, "1");
		await poll();
		const finished = listBoschBikesForNaming("one");
		const request = await vi.waitFor(async () => {
			const next = await poll();
			expect(next).toMatchObject({ inventoryOnly: true });
			if (!next) throw new Error("Expected an authenticated poll");
			return next;
		});
		expect(
			await acceptBoschUpload(
				pair.pairingToken,
				async () => bikeData,
				request.requestId,
			),
		).toBe(400);
		expect(
			await acceptBoschUpload(
				pair.pairingToken,
				async () => ({ bikes: [] }),
				request.requestId,
			),
		).toBe(204);
		await finished;
		expect(await readBoschSnapshot("one", pair.connectionId)).toBeNull();
	});
	it("withholds the cached bikes and rides if Bosch denies the helper's inventory access", async () => {
		const pair = await pairBoschBridge("one");
		await acceptBoschUpload(pair.pairingToken, async () => bikeData);
		const poll = (failed: string | null = null) =>
			pollBoschQuestion(
				pair.pairingToken,
				failed,
				"2",
				"",
				failed ? "access_denied" : null,
				"1",
			);
		await poll();
		const result = listBoschBikesForNaming("one");
		const requestId = await vi.waitFor(async () => {
			const next = await poll();
			if (!next?.requestId) throw Error("Waiting for inventory request");
			return next.requestId;
		});
		await poll(requestId);
		expect(await result).toBeNull();
		expect(await readBoschSnapshot("one", pair.connectionId)).toBeNull();
	});
	it("limits automatic full reads for older helpers", async () => {
		const pair = await pairBoschBridge("one");
		const poll = () => pollBoschQuestion(pair.pairingToken, null);
		await poll();
		const first = listBoschBikesForNaming("one");
		const request = await vi.waitFor(async () => {
			const next = await poll();
			expect(next?.requestId).toBeTruthy();
			if (!next) throw new Error("Expected an authenticated poll");
			return next;
		});
		expect(request).not.toHaveProperty("inventoryOnly");
		expect(
			await acceptBoschUpload(
				pair.pairingToken,
				async () => bikeData,
				request.requestId,
			),
		).toBe(204);
		await first;
		await listBoschBikesForNaming("one");
		expect((await poll())?.requestId).toBeNull();
	});
	it("shares a pending read and preserves the dated snapshot if the helper fails mid-upload", async () => {
		const pair = await pairBoschBridge("one");
		await acceptBoschUpload(pair.pairingToken, async () => bikeData);
		const cached = await readBoschSnapshot("one", pair.connectionId);
		await pollBoschQuestion(pair.pairingToken, null);
		const answers = Promise.all([
			loadBoschForQuestion("one", pair.connectionId),
			loadBoschForQuestion("one", pair.connectionId),
		]);
		let requestId: string | null = null;
		await vi.waitFor(async () => {
			requestId =
				(await pollBoschQuestion(pair.pairingToken, null))?.requestId ?? null;
			expect(requestId).toBeTruthy();
		});
		const late = await acceptBoschUpload(
			pair.pairingToken,
			async () => {
				await pollBoschQuestion(pair.pairingToken, requestId);
				return { ...bikeData, bikes: [] };
			},
			requestId,
		);
		expect(late).toBe(409);
		expect(await answers).toEqual(
			Array(2).fill({ snapshot: cached, fresh: false }),
		);
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

describe("private on-demand Bosch detail", () => {
	it("does not queue detail for an offline or summary-only helper", async () => {
		const pair = await pairBoschBridge("one");
		const query = { action: "bike_profile", id: "b1" } as const;
		expect(
			await loadBoschDetailForQuestion("one", pair.connectionId, query),
		).toEqual({ status: "offline" });
		await pollBoschQuestion(pair.pairingToken, null);
		expect(
			await loadBoschDetailForQuestion("one", pair.connectionId, query),
		).toEqual({ status: "consent_required" });
		expect(
			(await pollBoschQuestion(pair.pairingToken, null))?.requestId,
		).toBeNull();
	});
});

it("binds an ephemeral detail response to the specific consenting rider, query and request", async () => {
	const owner = await pairBoschBridge("one"),
		other = await pairBoschBridge("two");
	const query = {
		action: "bike_profile",
		id: "b1",
		field: "driveUnit.odometer",
	} as const;
	const result = {
		fields: [{ path: "driveUnit.odometer", value: 120034 }],
		nextOffset: null,
	};
	await pollBoschQuestion(owner.pairingToken, null, "2", "details");
	const answer = loadBoschDetailForQuestion("one", owner.connectionId, query);
	let requestId: string | null = null;
	await vi.waitFor(async () => {
		const next = await pollBoschQuestion(
			owner.pairingToken,
			null,
			"2",
			"details",
		);
		expect(next).toMatchObject({ query });
		requestId = next?.requestId ?? null;
	});
	expect(
		await acceptBoschUpload(
			other.pairingToken,
			async () => ({ query, result }),
			requestId,
		),
	).toBe(409);
	expect(
		await acceptBoschUpload(
			owner.pairingToken,
			async () => ({ query: { ...query, id: "b2" }, result }),
			requestId,
		),
	).toBe(400);
	expect(
		await acceptBoschUpload(
			owner.pairingToken,
			async () => ({
				query,
				result: {
					...result,
					fields: [{ path: "privateToken", value: "not a field" }],
				},
			}),
			requestId,
		),
	).toBe(400);
	expect(
		await acceptBoschUpload(
			owner.pairingToken,
			async () => ({ query, result }),
			null,
		),
	).toBe(400);
	expect(
		await acceptBoschUpload(
			owner.pairingToken,
			async () => ({ query, result }),
			requestId,
		),
	).toBe(204);
	expect(await answer).toEqual({ status: "ready", result });
	expect(await readBoschSnapshot("one", owner.connectionId)).toBeNull();
	expect(
		await acceptBoschUpload(
			owner.pairingToken,
			async () => ({ query, result }),
			requestId,
		),
	).toBe(409);
});
it("withdrawing location access resolves only that scoped question without releasing private fields", async () => {
	const owner = await pairBoschBridge("one");
	await pollBoschQuestion(owner.pairingToken, null, "2", "details,location");
	const route = loadBoschDetailForQuestion("one", owner.connectionId, {
		action: "ride_route",
		id: "r1",
	});
	let requestId: string | null = null;
	await vi.waitFor(async () => {
		const next = await pollBoschQuestion(
			owner.pairingToken,
			null,
			"2",
			"details,location",
		);
		requestId = next?.requestId ?? null;
		expect(requestId).toBeTruthy();
	});
	const profile = loadBoschDetailForQuestion("one", owner.connectionId, {
		action: "bike_profile",
		id: "b1",
	});
	await vi.waitFor(async () => {
		expect(
			await pollBoschQuestion(owner.pairingToken, null, "2", "details"),
		).toMatchObject({ query: { action: "bike_profile" } });
	});
	expect(await route).toEqual({ status: "consent_required" });
	expect(
		await acceptBoschUpload(owner.pairingToken, async () => ({}), requestId),
	).toBe(409);
	const next = await pollBoschQuestion(
		owner.pairingToken,
		null,
		"2",
		"details",
	);
	await pollBoschQuestion(
		owner.pairingToken,
		next?.requestId ?? null,
		"2",
		"details",
	);
	expect(await profile).toEqual({ status: "unavailable" });
});
