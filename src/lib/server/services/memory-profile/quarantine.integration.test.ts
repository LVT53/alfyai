import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let harness: EngineHarness;
beforeEach(async () => {
	harness = await bootEngine("memory-quarantine");
});
afterEach(() => harness.cleanup());

it("keeps quarantine unavailable without session-specific authorization", async () => {
	const { getMemoryQuarantine, startMemoryQuarantine } = await import(
		"./quarantine"
	);
	expect(getMemoryQuarantine(harness.userId)).toEqual({
		status: "unavailable",
		candidates: [],
	});
	await expect(
		startMemoryQuarantine(harness.userId, { requestId: randomUUID() }),
	).rejects.toMatchObject({ code: "memory_quarantine_unavailable" });
});

async function prepareOwner() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const { getConfig } = await import("$lib/server/config-store");
	const config = await import("$lib/server/config-store");
	const { eq } = await import("drizzle-orm");
	const { ensureMemoryBank, memoryTextHash } = await import("./revisions");
	const { inspectMemoryMigration } = await import("./migration-progress");
	const { nativeMemoryClient, HindsightClient } = await import(
		"./hindsight-client"
	);
	const client = await import("./hindsight-client");
	const owner = harness.userId;
	const now = new Date();
	const older = new Date(now.getTime() - 60_000);
	const bank = ensureMemoryBank(owner, { kind: "personal" });
	db.update(schema.memoryAccounts)
		.set({
			authority: "preparing",
			historyChoice: "include",
			historyCutoff: now,
		})
		.where(eq(schema.memoryAccounts.userId, owner))
		.run();
	db.update(schema.memoryBanks)
		.set({
			nativeBaseUrl: "http://synthetic",
			nativeCredentialHash: "test-pinned",
		})
		.where(eq(schema.memoryBanks.id, bank.id))
		.run();
	db.insert(schema.memoryProjectionState)
		.values({ id: "projection", userId: owner })
		.run();
	db.insert(schema.memoryProfileItems)
		.values({
			id: "old",
			userId: owner,
			projectionStateId: "projection",
			category: "about_you",
			itemKey: "old",
			status: "deleted",
			statement: "The forbidden archived nickname was Minnow.",
			deletedAt: now,
		})
		.run();

	for (const [id, value, incognito] of [
		["a", "I have a turquoise canoe.", false],
		["b", "My canoe is turquoise and lives in the shed.", false],
		[
			"blocked",
			"The forbidden archived nickname was Minnow. I paddle with friends.",
			false,
		],
		["incognito", "This private turn is not approved.", true],
	] as const) {
		db.insert(schema.conversations)
			.values({
				id: `chat-${id}`,
				userId: owner,
				title: id,
				memoryIncognito: incognito,
			})
			.run();
		db.insert(schema.messages)
			.values({
				id,
				role: "user",
				conversationId: `chat-${id}`,
				content: value,
				createdAt: older,
			})
			.run();
	}
	const inventory = inspectMemoryMigration(owner);
	expect(inventory.holdHistory).toBe(true);
	const cohort = inventory.sources
		.filter((source) => source.eligibility === "held")
		.map(({ id }) => id)
		.sort();
	expect(cohort).toEqual(["a", "b", "blocked"]);
	const email = db
		.select({ email: schema.users.email })
		.from(schema.users)
		.where(eq(schema.users.id, owner))
		.get()?.email;
	if (!email) throw Error("missing synthetic owner");
	const approval = {
		manifestId: "manifest",
		email,
		cutoff: new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
		cohortCount: cohort.length,
		cohortHash: memoryTextHash(JSON.stringify(cohort)),
		manifestHash: memoryTextHash(JSON.stringify(inventory)),
		allowedCohortHash: memoryTextHash(JSON.stringify(cohort)),
		deniedSourceIds: [] as string[],
	};
	db.insert(schema.memoryMigrationManifests)
		.values({
			id: approval.manifestId,
			userId: owner,
			epoch: 0,
			status: "prepared",
			manifestJson: JSON.stringify(inventory),
		})
		.run();
	const enabledConfig = {
		...getConfig(),
		hindsightWorkerEnabled: true,
		hindsightQuarantineEnabled: true,
	};
	vi.spyOn(config, "getConfig").mockReturnValue(enabledConfig);
	const native = new HindsightClient({
		baseUrl: "http://synthetic",
		apiKey: "key",
		bankId: bank.id,
		fetcher: vi.fn(async () => {
			throw Error("unexpected transport");
		}),
	});
	vi.spyOn(client, "nativeMemoryClient").mockImplementation(
		(..._args: Parameters<typeof nativeMemoryClient>) => native,
	);
	const extract = vi
		.spyOn(native, "extractDrafts")
		.mockImplementation(async (_input, beforeDispatch) => {
			await beforeDispatch();
			return [
				{ text: "The owner has a turquoise canoe." },
				{ text: "The owner likes paddling." },
			];
		});
	return { db, schema, owner, bank, approval, extract };
}

it("keeps only eligible owner drafts outside native Memory, deduplicates them, and queues an explicit fresh keep", async () => {
	const { db, schema, owner, approval, extract } = await prepareOwner();
	const {
		authorizeMemoryQuarantine,
		startMemoryQuarantine,
		getMemoryQuarantine,
		resolveMemoryQuarantineCandidate,
	} = await import("./quarantine");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const other = harness.fixture.seedUser("another-owner");
	expect(() =>
		authorizeMemoryQuarantine(owner, {
			...approval,
			cohortHash: "0".repeat(64),
		}),
	).toThrow("memory_quarantine_unavailable");
	expect(getMemoryQuarantine(owner).status).toBe("unavailable");
	authorizeMemoryQuarantine(owner, approval);
	expect(getMemoryQuarantine(owner).status).toBe("idle");
	expect(getMemoryQuarantine(other)).toEqual({
		status: "unavailable",
		candidates: [],
	});

	const requestId = randomUUID();
	expect((await startMemoryQuarantine(owner, { requestId })).status).toBe(
		"working",
	);
	await startMemoryQuarantine(owner, { requestId });
	expect(db.select().from(schema.memoryDeliveryJobs).all()).toHaveLength(2);
	const { verifyMemoryMigration } = await import("./migration-progress");
	expect(verifyMemoryMigration(owner, approval.manifestId).pending).toBe(0);
	await harness.engine.drain(memoryDeliveryJob);
	expect(extract.mock.calls.map(([input]) => input.content).sort()).toEqual([
		"I have a turquoise canoe.",
		"My canoe is turquoise and lives in the shed.",
	]);
	expect(db.select().from(schema.memorySourceRevisions).all()).toHaveLength(0);
	expect(db.select().from(schema.memoryPublishedRows).all()).toHaveLength(0);
	const { eq } = await import("drizzle-orm");
	const { listMemory } = await import("./native-read");
	db.update(schema.memoryAccounts)
		.set({ authority: "hindsight" })
		.where(eq(schema.memoryAccounts.userId, owner))
		.run();
	expect(listMemory(owner, { scope: { kind: "personal" } }).rows).toEqual([]);
	db.update(schema.memoryAccounts)
		.set({ authority: "preparing" })
		.where(eq(schema.memoryAccounts.userId, owner))
		.run();
	const view = getMemoryQuarantine(owner);
	expect(view.status).toBe("pending");
	expect(view.candidates).toHaveLength(2);
	const keep = view.candidates.find(({ text }) => text.includes("canoe"));
	const discard = view.candidates.find(({ text }) => text.includes("paddling"));
	if (!keep || !discard) throw Error("missing draft");
	const decision = {
		id: keep.id,
		decision: "keep" as const,
		text: "I own a turquoise canoe.",
		requestId: randomUUID(),
	};
	await expect(
		resolveMemoryQuarantineCandidate(other, decision),
	).rejects.toMatchObject({ code: "memory_quarantine_unavailable" });
	await expect(
		resolveMemoryQuarantineCandidate(owner, {
			...decision,
			text: "The forbidden archived nickname was Minnow.",
		}),
	).rejects.toMatchObject({ code: "invalid_action" });
	await resolveMemoryQuarantineCandidate(owner, decision);
	await resolveMemoryQuarantineCandidate(owner, decision);
	await expect(
		resolveMemoryQuarantineCandidate(owner, { ...decision, text: "different" }),
	).rejects.toMatchObject({ code: "request_conflict" });
	await resolveMemoryQuarantineCandidate(owner, {
		id: discard.id,
		decision: "discard",
		requestId: randomUUID(),
	});
	expect(getMemoryQuarantine(owner)).toMatchObject({
		status: "complete",
		candidates: [],
		approvals: [
			{
				id: keep.id,
				status: "queued",
				text: "I own a turquoise canoe.",
				retryable: false,
			},
		],
	});
	const { retryMemoryQuarantineApproval } = await import("./quarantine");
	db.update(schema.memoryDeliveryJobs)
		.set({ status: "failed", retryable: true })
		.where(
			eq(schema.memoryDeliveryJobs.requestId, `action:${decision.requestId}`),
		)
		.run();
	expect(getMemoryQuarantine(owner).approvals).toMatchObject([
		{ id: keep.id, status: "failed", retryable: true },
	]);
	expect(
		(await retryMemoryQuarantineApproval(owner, { id: keep.id })).approvals,
	).toMatchObject([{ id: keep.id, status: "queued", retryable: false }]);
	expect(db.select().from(schema.memoryActions).all()).toMatchObject([
		{ kind: "add", text: "I own a turquoise canoe." },
	]);
	expect(db.select().from(schema.memoryQuarantineDrafts).all()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ decision: "keep", text: null }),
			expect.objectContaining({ decision: "discard", text: null }),
		]),
	);
	expect(db.select().from(schema.memoryAccounts).all()).toMatchObject([
		{ userId: owner, authority: "preparing" },
	]);
});

it("rechecks source privacy immediately before dry-run dispatch and scrubs a pending draft on disable", async () => {
	const { db, schema, owner, approval, extract } = await prepareOwner();
	const { eq } = await import("drizzle-orm");
	const {
		authorizeMemoryQuarantine,
		startMemoryQuarantine,
		getMemoryQuarantine,
	} = await import("./quarantine");
	const { memoryDeliveryJob } = await import("./delivery-job");
	let dispatched = 0;
	extract.mockImplementation(async (input, beforeDispatch) => {
		if (input.content.startsWith("I have a turquoise")) {
			db.update(schema.conversations)
				.set({ memoryIncognito: true })
				.where(eq(schema.conversations.id, "chat-a"))
				.run();
		}
		await beforeDispatch();
		dispatched++;
		return [{ text: "The owner has a turquoise canoe." }];
	});
	authorizeMemoryQuarantine(owner, approval);
	await startMemoryQuarantine(owner, { requestId: randomUUID() });
	await harness.engine.drain(memoryDeliveryJob);
	expect(dispatched).toBe(1);
	expect(
		getMemoryQuarantine(owner).candidates.map(({ source }) => source.messageId),
	).toEqual(["b"]);
	db.update(schema.users)
		.set({ memoryEnabled: false })
		.where(eq(schema.users.id, owner))
		.run();
	expect(getMemoryQuarantine(owner).status).toBe("unavailable");
	expect(db.select().from(schema.memoryQuarantineDrafts).all()).toHaveLength(0);
});

it("blocks a held source with an accepted native removal replay even though held inventory has no replay IDs", async () => {
	const { db, schema, owner, bank, approval, extract } = await prepareOwner();
	const { eq } = await import("drizzle-orm");
	const { recordMemorySource } = await import("./revisions");
	const { authorizeMemoryQuarantine, startMemoryQuarantine } = await import(
		"./quarantine"
	);
	const { memoryDeliveryJob } = await import("./delivery-job");
	const message = db
		.select()
		.from(schema.messages)
		.where(eq(schema.messages.id, "a"))
		.get();
	if (!message) throw Error("missing synthetic assertion");
	const source = recordMemorySource({
		userId: owner,
		bankId: bank.id,
		epoch: 0,
		eventId: "message:a",
		lineageId: "a",
		messageId: "a",
		conversationId: "chat-a",
		text: message.content,
		context: "",
		assertedAt: message.createdAt,
	});
	db.update(schema.memorySourceRevisions)
		.set({ state: "accepted" })
		.where(eq(schema.memorySourceRevisions.id, source.id))
		.run();
	const requestId = randomUUID();
	db.insert(schema.memoryActions)
		.values({
			id: "prior-remove",
			userId: owner,
			bankId: bank.id,
			epoch: 0,
			requestId,
			kind: "remove",
			exclusionAcknowledged: true,
			intentJson: JSON.stringify({
				request: {
					kind: "remove",
					requestId,
					ref: { scope: { kind: "personal" }, rowId: "row", generation: "old" },
				},
				before: "Removed historical fact",
				sourceIds: [source.id],
				facts: [],
				outcome: "accepted",
			}),
		})
		.run();
	authorizeMemoryQuarantine(owner, approval);
	await startMemoryQuarantine(owner, { requestId: randomUUID() });
	await harness.engine.drain(memoryDeliveryJob);
	expect(extract.mock.calls.map(([input]) => input.content)).toEqual([
		"My canoe is turquoise and lives in the shed.",
	]);
});

it("rejects a stolen durable attempt and purges quarantined drafts on restore or rollback", async () => {
	const { db, schema, owner, approval, extract } = await prepareOwner();
	const { eq } = await import("drizzle-orm");
	const config = await import("$lib/server/config-store");
	const {
		authorizeMemoryQuarantine,
		startMemoryQuarantine,
		getMemoryQuarantine,
		purgeRestoredMemoryQuarantine,
	} = await import("./quarantine");
	const { memoryDeliveryJob } = await import("./delivery-job");
	extract.mockImplementation(async (input, beforeDispatch) => {
		if (input.content.startsWith("I have a turquoise")) {
			db.update(schema.memoryDeliveryJobs)
				.set({ currentAttemptId: null, status: "cancelled" })
				.where(eq(schema.memoryDeliveryJobs.sourceId, "a"))
				.run();
			expect(beforeDispatch).toThrow("memory_source_control_changed");
			return [];
		}
		await beforeDispatch();
		return [{ text: "The owner has a turquoise canoe." }];
	});
	authorizeMemoryQuarantine(owner, approval);
	await startMemoryQuarantine(owner, { requestId: randomUUID() });
	await harness.engine.drain(memoryDeliveryJob);
	expect(getMemoryQuarantine(owner).candidates).toHaveLength(1);
	const enabled = config.getConfig();
	vi.mocked(config.getConfig).mockReturnValue({
		...enabled,
		hindsightRestoreHold: true,
	});
	purgeRestoredMemoryQuarantine();
	expect(db.select().from(schema.memoryQuarantineDrafts).all()).toHaveLength(0);
	vi.mocked(config.getConfig).mockReturnValue(enabled);
	expect(getMemoryQuarantine(owner).status).toBe("unavailable");
	authorizeMemoryQuarantine(owner, approval);
	db.update(schema.memoryAccounts)
		.set({ authority: "legacy" })
		.where(eq(schema.memoryAccounts.userId, owner))
		.run();
	db.update(schema.memoryAccounts)
		.set({ authority: "preparing" })
		.where(eq(schema.memoryAccounts.userId, owner))
		.run();
	expect(getMemoryQuarantine(owner).status).toBe("unavailable");
});

it("binds a reviewed denial and allowed-ID hash to the independently pinned manifest", async () => {
	const { owner, approval, extract } = await prepareOwner();
	const { authorizeMemoryQuarantine, startMemoryQuarantine } = await import(
		"./quarantine"
	);
	const { memoryTextHash } = await import("./revisions");
	const { memoryDeliveryJob } = await import("./delivery-job");
	expect(() =>
		authorizeMemoryQuarantine(owner, {
			...approval,
			manifestHash: "0".repeat(64),
		}),
	).toThrow("memory_quarantine_unavailable");
	expect(() =>
		authorizeMemoryQuarantine(owner, { ...approval, deniedSourceIds: ["a"] }),
	).toThrow("memory_quarantine_unavailable");
	expect(
		authorizeMemoryQuarantine(owner, {
			...approval,
			deniedSourceIds: ["a"],
			allowedCohortHash: memoryTextHash(JSON.stringify(["b", "blocked"])),
		}),
	).toEqual({
		cohortCount: 3,
		operatorExcluded: 1,
		dispatchEligible: 1,
		heldBySourceFences: 1,
	});
	await startMemoryQuarantine(owner, { requestId: randomUUID() });
	await harness.engine.drain(memoryDeliveryJob);
	expect(extract.mock.calls.map(([input]) => input.content)).toEqual([
		"My canoe is turquoise and lives in the shed.",
	]);
});
