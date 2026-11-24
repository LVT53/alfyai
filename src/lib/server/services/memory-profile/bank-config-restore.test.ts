import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-config-restore");
});
afterEach(() => h.cleanup());

async function fixture() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const native = await import("./contracts");
	const { HindsightClient } = await import("./hindsight-client");
	const { restoreBankConfigs } = await import("./bank-config-restore");
	const { eq } = await import("drizzle-orm");
	const revisions = await import("./revisions");
	const personal = revisions.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(schema.memoryAccounts).set({ authority: "hindsight" }).run();
	const account = db.select().from(schema.memoryAccounts).get();
	if (!account) throw Error("fixture account");
	db.update(schema.memoryBanks)
		.set({
			id: "upgraded",
			nativeConfigVersion: native.NATIVE_BANK_CONFIG_VERSION,
		})
		.where(eq(schema.memoryBanks.id, personal.id))
		.run();
	const bank = (
		id: string,
		scopeKey: string,
		version: string,
		status = "ready",
	) =>
		db
			.insert(schema.memoryBanks)
			.values({
				id,
				userId: h.userId,
				scopeKey,
				epoch: account.epoch,
				status,
				nativeConfigVersion: version,
			})
			.run();
	bank("old", "project:p1", native.HINDSIGHT_ENGINE_COMMIT);
	bank("retired", "project:p2", native.NATIVE_BANK_CONFIG_VERSION, "retired");
	const patched: string[] = [];
	const live = new Map<string, unknown>();
	const clientFor = (bankId: string) =>
		new HindsightClient({
			baseUrl: "http://native",
			apiKey: "key",
			bankId,
			fetcher: vi.fn<typeof fetch>(async (_url, init) => {
				if (init?.method === "PATCH") {
					patched.push(bankId);
					live.set(bankId, JSON.parse(String(init.body)).updates);
				}
				return Response.json({ config: live.get(bankId) ?? {} });
			}),
		});
	const version = (id: string) =>
		db
			.select()
			.from(schema.memoryBanks)
			.all()
			.find((row) => row.id === id)?.nativeConfigVersion;
	// The label migration verified the account's epoch while its banks were on config 2.
	db.update(schema.memoryAccounts)
		.set({ labelsVerifiedEpoch: account.epoch })
		.run();
	const verifiedEpoch = () =>
		db.select().from(schema.memoryAccounts).get()?.labelsVerifiedEpoch;
	return {
		native,
		restoreBankConfigs,
		clientFor,
		patched,
		version,
		verifiedEpoch,
		epoch: account.epoch,
	};
}

describe("restoring config 1 for a rollback", () => {
	it("counts by default and changes nothing", async () => {
		const f = await fixture();
		const clientFor = vi.fn(f.clientFor);
		expect(await f.restoreBankConfigs({ execute: false, clientFor })).toEqual({
			mode: "inspect",
			versions: { config2: 1, config1: 1, pending: 0, other: 0 },
			restored: 0,
			failed: {},
		});
		expect(clientFor).not.toHaveBeenCalled();
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("puts every live config 2 bank back on config 1 and its version back", async () => {
		const f = await fixture();
		const report = await f.restoreBankConfigs({
			execute: true,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ mode: "execute", restored: 1, failed: {} });
		expect(f.patched).toEqual(["upgraded"]);
		expect(f.version("upgraded")).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
		expect(f.version("old")).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
		expect(f.version("retired")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	// The previous release writes facts without labels, so after a roll forward
	// the account's labels are to be verified again: the verification is forgotten.
	it("forgets the verification of an account whose bank it restored", async () => {
		const f = await fixture();
		expect(f.verifiedEpoch()).toBe(f.epoch);
		await f.restoreBankConfigs({ execute: false, clientFor: f.clientFor });
		expect(f.verifiedEpoch()).toBe(f.epoch);
		await f.restoreBankConfigs({ execute: true, clientFor: f.clientFor });
		expect(f.verifiedEpoch()).toBeNull();
	});

	it("leaves a bank whose restore failed on config 2, and counts it by code", async () => {
		const f = await fixture();
		const { HindsightClient } = await import("./hindsight-client");
		const report = await f.restoreBankConfigs({
			execute: true,
			clientFor: (bankId) =>
				new HindsightClient({
					baseUrl: "http://native",
					apiKey: "key",
					bankId,
					fetcher: vi.fn<typeof fetch>(
						async () => new Response("down", { status: 503 }),
					),
				}),
		});
		expect(report).toMatchObject({
			restored: 0,
			failed: { native_unavailable: 1 },
		});
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
		expect(f.verifiedEpoch()).toBe(f.epoch);
	});
});
