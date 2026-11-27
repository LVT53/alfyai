import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { findConnectionByAccount } from "../store";
import {
	loadBoschDetailForQuestion,
	loadBoschForQuestion,
	pairBoschBridge,
	pollBoschQuestion,
} from "./bosch-flow-bridge";
import {
	completeBoschHostedSetup,
	getBoschHostedSetup,
	setBoschHostedGrants,
	startBoschHostedSetup,
} from "./bosch-flow-hosted";

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
afterEach(() => {
	vi.unstubAllGlobals();
	sqlite.close();
});

const callback = new URL(
	"https://example.org/api/connections/bosch/hosted/callback",
);
const input = { clientId: "personal-client", grants: ["details" as const] };
const token = () =>
	new Response(
		JSON.stringify({
			access_token: "rider-access",
			refresh_token: "rider-refresh",
			token_type: "bearer",
			expires_in: 600,
		}),
	);
describe("hosted Bosch setup", () => {
	it("binds each one-time callback to its rider and keeps a working helper until success", async () => {
		const helper = await pairBoschBridge("one");
		const { state, url } = await startBoschHostedSetup("one", input, callback);
		expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
		expect(await getBoschHostedSetup("one")).toMatchObject({ mode: "helper" });
		const fetcher = vi.fn(token);
		await expect(
			completeBoschHostedSetup("two", "code", state, callback, fetcher),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
		await completeBoschHostedSetup("one", "code", state, callback, fetcher);
		await expect(
			completeBoschHostedSetup("one", "code", state, callback, fetcher),
		).rejects.toThrow();
		expect(await pollBoschQuestion(helper.pairingToken, null)).toBeNull();
		expect(await getBoschHostedSetup("one")).toEqual({
			mode: "hosted",
			grants: ["details"],
		});
		expect(await getBoschHostedSetup("two")).toEqual({
			mode: "none",
			grants: [],
		});
		expect(await setBoschHostedGrants("two", ["fitness"])).toBe(false);
		expect(
			await loadBoschDetailForQuestion("one", helper.connectionId, {
				action: "ride_route",
				id: "ride",
			}),
		).toEqual({ status: "consent_required" });
		expect(await setBoschHostedGrants("one", [])).toBe(true);
		expect(await getBoschHostedSetup("one")).toEqual({
			mode: "hosted",
			grants: [],
		});
	});
	it("reads on demand, keeps a cached summary, and refreshes a rotating token once for simultaneous questions", async () => {
		const { state } = await startBoschHostedSetup("one", input, callback);
		await completeBoschHostedSetup("one", "code", state, callback, async () =>
			Response.json({
				access_token: "old",
				refresh_token: "first-refresh",
				token_type: "Bearer",
				expires_in: 1,
			}),
		);
		const conn = await findConnectionByAccount("one", "bosch", "personal");
		if (!conn) throw new Error("Expected hosted connection");
		const fetcher = vi.fn(async (url: string, request: RequestInit) => {
			if (url.endsWith("/token")) {
				expect(String(request.body)).toContain("refresh_token=first-refresh");
				return token();
			}
			expect(new Headers(request.headers).get("Authorization")).toBe(
				"Bearer rider-access",
			);
			if (url.includes("/bikes/bike"))
				return Response.json({ id: "bike", name: "Personal Cube" });
			if (url.endsWith("/bikes"))
				return Response.json({
					bikes: [{ id: "bike", name: "Personal Cube" }],
				});
			return Response.json({ activitySummaries: [] });
		});
		vi.stubGlobal("fetch", fetcher);
		const [summary, detail] = await Promise.all([
			loadBoschForQuestion("one", conn.id),
			loadBoschDetailForQuestion("one", conn.id, {
				action: "bike_profile",
				id: "bike",
			}),
		]);
		expect(summary).toMatchObject({
			fresh: true,
			snapshot: { bikes: [{ id: "bike", name: "Personal Cube" }] },
		});
		expect(detail).toMatchObject({
			status: "ready",
			result: {
				fields: expect.arrayContaining([
					{ path: "name", value: "Personal Cube" },
				]),
			},
		});
		expect(
			fetcher.mock.calls.filter(([url]) => url.endsWith("/token")),
		).toHaveLength(1);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
		expect(await loadBoschForQuestion("one", conn.id)).toMatchObject({
			fresh: false,
			snapshot: { bikes: [{ id: "bike", name: "Personal Cube" }] },
		});
	});
	it("discards a detail result if the rider withdraws access while the provider is answering", async () => {
		const { state } = await startBoschHostedSetup("one", input, callback);
		await completeBoschHostedSetup("one", "code", state, callback, token);
		const conn = await findConnectionByAccount("one", "bosch", "personal");
		if (!conn) throw new Error("Expected hosted connection");
		let deliver!: (response: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((done) => {
					deliver = done;
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const result = loadBoschDetailForQuestion("one", conn.id, {
			action: "bike_profile",
			id: "bike",
		});
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		await setBoschHostedGrants("one", []);
		deliver(Response.json({ id: "bike", name: "Personal Cube" }));
		expect(await result).toEqual({ status: "consent_required" });
	});
	it("expires a dormant sign-in even when no rider starts another", async () => {
		vi.useFakeTimers();
		try {
			const { state } = await startBoschHostedSetup("one", input, callback);
			await vi.advanceTimersByTimeAsync(600_001);
			const fetcher = vi.fn(token);
			await expect(
				completeBoschHostedSetup("one", "code", state, callback, fetcher),
			).rejects.toThrow();
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps the earlier grant if Bosch declines a replacement", async () => {
		const helper = await pairBoschBridge("one");
		const { state } = await startBoschHostedSetup("one", input, callback);
		await expect(
			completeBoschHostedSetup(
				"one",
				"code",
				state,
				callback,
				async () => new Response(null, { status: 403 }),
			),
		).rejects.toThrow();
		expect(await pollBoschQuestion(helper.pairingToken, null)).toMatchObject({
			requestId: null,
		});
	});
});
