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
	// Config 3's neighbours: a project bank on config 3, and a bank on config 2.
	bank("upgraded-project", "project:p3", native.NATIVE_BANK_CONFIG_VERSION);
	bank("on-config-2", "project:p4", native.NATIVE_BANK_CONFIG_2_VERSION);
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
	const marks = (userId: string) => {
		const row = db
			.select()
			.from(schema.memoryAccounts)
			.where(eq(schema.memoryAccounts.userId, userId))
			.get();
		return {
			epoch: row?.epoch,
			unverified: row?.labelsUnverifiedEpoch,
			verified: row?.labelsVerifiedEpoch,
		};
	};
	/** Another native account whose only bank is on config 1, verified by the label migration. */
	const seedVerifiedOnConfigOne = (userId: string, excluded = false) => {
		h.fixture.seedUser(userId);
		const other = revisions.ensureMemoryBank(userId, { kind: "personal" });
		db.update(schema.memoryBanks)
			.set({ nativeConfigVersion: native.HINDSIGHT_ENGINE_COMMIT })
			.where(eq(schema.memoryBanks.id, other.id))
			.run();
		db.update(schema.memoryAccounts)
			.set({
				authority: "hindsight",
				labelsUnverifiedEpoch: null,
				labelsVerifiedEpoch: 0,
			})
			.where(eq(schema.memoryAccounts.userId, userId))
			.run();
		db.update(schema.users)
			.set({ memoryMigrationExcluded: excluded })
			.where(eq(schema.users.id, userId))
			.run();
	};
	const sent = (bankId: string) => live.get(bankId);
	return {
		native,
		restoreBankConfigs,
		clientFor,
		patched,
		sent,
		version,
		verifiedEpoch,
		marks,
		seedVerifiedOnConfigOne,
		epoch: account.epoch,
	};
}

describe("restoring config 1 for a rollback to the first release", () => {
	it("counts by default and changes nothing", async () => {
		const f = await fixture();
		const clientFor = vi.fn(f.clientFor);
		expect(await f.restoreBankConfigs({ execute: false, clientFor })).toEqual({
			mode: "inspect",
			versions: { config3: 2, config2: 1, config1: 1, pending: 0, other: 0 },
			restored: 0,
			unverified: 1,
			failed: {},
		});
		expect(clientFor).not.toHaveBeenCalled();
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("puts every live config 3 and config 2 bank back on config 1 and its version back", async () => {
		const f = await fixture();
		const report = await f.restoreBankConfigs({
			execute: true,
			to: 1,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ mode: "execute", restored: 3, failed: {} });
		expect([...f.patched].sort()).toEqual([
			"on-config-2",
			"upgraded",
			"upgraded-project",
		]);
		for (const id of ["upgraded", "upgraded-project", "on-config-2", "old"])
			expect(f.version(id)).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
		expect(f.version("retired")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("restores config 1 by default, as the command always did", async () => {
		const f = await fixture();
		await f.restoreBankConfigs({ execute: true, clientFor: f.clientFor });
		expect(f.version("upgraded")).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
		expect(f.version("on-config-2")).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
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

	// After the restore the previous release writes facts without labels into
	// any account's banks, and may create config-1 banks: every account it will
	// serve is returned to today's page, its verification revoked (an in-place
	// upgrade after the roll forward does not mark a verified epoch again).
	it("returns every account to today's page once every bank is back on config 1", async () => {
		const f = await fixture();
		f.seedVerifiedOnConfigOne("verified-on-config-1");
		const report = await f.restoreBankConfigs({
			execute: true,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ restored: 3, unverified: 2, failed: {} });
		expect(f.marks(h.userId)).toEqual({
			epoch: f.epoch,
			unverified: f.epoch,
			verified: null,
		});
		expect(f.marks("verified-on-config-1")).toEqual({
			epoch: 0,
			unverified: 0,
			verified: null,
		});
		const { memoryLabelsVerified } = await import("./labels-verified");
		expect(memoryLabelsVerified(h.userId)).toBe(false);
		expect(memoryLabelsVerified("verified-on-config-1")).toBe(false);
	});

	it("leaves the tester's page state as it is", async () => {
		const f = await fixture();
		f.seedVerifiedOnConfigOne("tester", true);
		const report = await f.restoreBankConfigs({
			execute: true,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ unverified: 1, failed: {} });
		expect(f.marks("tester")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
	});

	it("leaves a bank whose restore failed on its version, and counts it by code", async () => {
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
			failed: { native_unavailable: 3 },
		});
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
		expect(f.version("on-config-2")).toBe(
			f.native.NATIVE_BANK_CONFIG_2_VERSION,
		);
		expect(f.verifiedEpoch()).toBe(f.epoch);
	});
});

describe("restoring config 2 for a rollback of one release", () => {
	it("puts only the config 3 banks back on their own kind's config 2, and their version back", async () => {
		const f = await fixture();
		const report = await f.restoreBankConfigs({
			execute: true,
			to: 2,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ mode: "execute", restored: 2, failed: {} });
		expect([...f.patched].sort()).toEqual(["upgraded", "upgraded-project"]);
		expect(f.sent("upgraded")).toEqual(f.native.nativeBankConfig2("personal"));
		expect(f.sent("upgraded-project")).toEqual(
			f.native.nativeBankConfig2("project"),
		);
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_2_VERSION);
		expect(f.version("upgraded-project")).toBe(
			f.native.NATIVE_BANK_CONFIG_2_VERSION,
		);
		// Banks on config 2 or 1 are the config 2 release's already.
		expect(f.version("on-config-2")).toBe(
			f.native.NATIVE_BANK_CONFIG_2_VERSION,
		);
		expect(f.version("old")).toBe(f.native.HINDSIGHT_ENGINE_COMMIT);
		expect(f.version("retired")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("leaves every account's label verification as it is: config 2 labels every new fact", async () => {
		const f = await fixture();
		f.seedVerifiedOnConfigOne("verified-on-config-1");
		expect(f.verifiedEpoch()).toBe(f.epoch);
		const report = await f.restoreBankConfigs({
			execute: true,
			to: 2,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ unverified: 0, failed: {} });
		expect(f.verifiedEpoch()).toBe(f.epoch);
		expect(f.marks("verified-on-config-1")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
	});

	it("leaves a bank whose restore failed on config 3, and counts it by code", async () => {
		const f = await fixture();
		const { HindsightClient } = await import("./hindsight-client");
		const report = await f.restoreBankConfigs({
			execute: true,
			to: 2,
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
			failed: { native_unavailable: 2 },
		});
		expect(f.version("upgraded")).toBe(f.native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("counts by default and changes nothing, whichever step back is meant", async () => {
		const f = await fixture();
		const report = await f.restoreBankConfigs({
			execute: false,
			to: 2,
			clientFor: f.clientFor,
		});
		expect(report).toMatchObject({ mode: "inspect", restored: 0 });
		expect(f.patched).toEqual([]);
	});
});
