// Reproduce the reviewed failures with synthetic fixtures in the existing Vitest harness.
const additions = {
	"delivery-job.integration.test.ts": `
it("judge: real wire retain includes previously allowed context after predecessor revocation", async () => {
	const f = await setup();
	const t = new Date("2026-06-01");
	const utc = (d: number) => new Date(t.getTime() + d * 1000);
	f.db
		.insert(f.schema.conversations)
		.values({ id: "c", userId: h.userId, title: "chat" })
		.run();
	f.db
		.insert(f.schema.memoryControlIntervals)
		.values({
			id: "known",
			userId: h.userId,
			enabled: true,
			epoch: 0,
			startedAt: utc(-2),
		})
		.run();
	f.db
		.insert(f.schema.messages)
		.values([
			{
				id: "m1",
				conversationId: "c",
				role: "user",
				content: "retired-secret-token",
				createdAt: utc(0),
				messageSequence: 1,
			},
			{
				id: "a1",
				conversationId: "c",
				role: "assistant",
				content: "ack",
				createdAt: utc(1),
				messageSequence: 2,
			},
			{
				id: "m2",
				conversationId: "c",
				role: "user",
				content: "ok",
				createdAt: utc(2),
				messageSequence: 3,
			},
			{
				id: "a2",
				conversationId: "c",
				role: "assistant",
				content: "ok",
				createdAt: utc(3),
				messageSequence: 4,
			},
		])
		.run();
	const earlier = f.rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "earlier",
		conversationId: "c",
		messageId: "m1",
		lineageId: "m1",
		text: "retired-secret-token",
		context: "",
		assertedAt: utc(0),
	});
	const { deliverCompletedMemoryTurn } = await import("./chat-delivery");
	await deliverCompletedMemoryTurn({
		userId: h.userId,
		conversationId: "c",
		userMessageId: "m2",
		assistantMessageId: "a2",
	});
	f.rev.revokeMemorySources(h.userId, [earlier.id]);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const post = f.fetcher.mock.calls.find(
		([u, i]) => String(u).endsWith("/memories") && i?.method === "POST",
	);
	expect(post).toBeTruthy();
	expect(JSON.parse(String(post![1]!.body)).items[0].context).toContain(
		"retired-secret-token",
	);
});
it("judge: changed phase inside an async prepare escapes the rolled-back enqueue transaction", async () => {
	const f = await setup();
	let resumed: () => void = () => {};
	const wait = new Promise<void>((r) => (resumed = r));
	const prepare = async (tx: any) => {
		await wait;
		tx.update(f.schema.memoryAccounts).set({ epoch: 77 }).run();
		return [];
	};
	await expect(
		h.engine.enqueueAtomic(f.jobs.memoryDeliveryJob, prepare as never),
	).rejects.toThrow("synchronous");
	resumed();
	await Promise.resolve();
	expect(f.db.select().from(f.schema.memoryAccounts).get()?.epoch).toBe(77);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).all()).toHaveLength(0);
});
it("judge: accepted, pruned operation prevents reset DELETE", async () => {
	const f = await setup();
	await f.enqueue();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const orig = f.fetcher.getMockImplementation()!;
	f.fetcher.mockImplementation(async (url, init) =>
		String(url).endsWith(f.source.nativeOperationId!)
			? new Response(JSON.stringify({ status: "not_found" }))
			: orig(url, init),
	);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const j = f.db.select().from(f.schema.memoryDeliveryJobs).get()!;
	expect(j.errorCode).toBe("native_acknowledgement_unknown");
	expect(f.fetcher.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(
		false,
	);
});
it("judge: real pinned unsupported bank verification method makes completed deletion terminal", async () => {
	const f = await setup();
	await f.enqueue();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const orig = f.fetcher.getMockImplementation()!;
	f.fetcher.mockImplementation(async (url, init) =>
		String(url).endsWith(f.bank.id) && init?.method === "GET"
			? new Response("", { status: 405 })
			: orig(url, init),
	);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const j = f.db.select().from(f.schema.memoryDeliveryJobs).get()!;
	expect(j.status).toBe("failed");
	expect(j.retryable).toBe(false);
	expect(f.fetcher.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(
		true,
	);
});
`,
	"native.test.ts": `
it("judge: revocation during a second bank call returns a revoked first-bank fact", async () => {
	seed("b1", "personal", "secret personal");
	seed("b2", "project:p", "project");
	let calls = 0;
	recall.mockImplementation(async () => {
		if (++calls === 2)
			drizzle(sqlite, { schema })
				.insert(schema.memoryRevocations)
				.values({
					id: "late",
					userId: "u",
					bankId: "b1",
					epoch: 0,
					sourceId: "s-b1",
				})
				.run();
		throw new Error("offline");
	});
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "x",
		tokenBudget: 300,
	});
	expect(calls).toBe(2);
	expect(result.map((r) => r.text)).toContain("secret personal");
});
`,
	"chat-delivery.test.ts": `
it("judge: old disabled turn replay and project move promote a private original", async () => {
	const { deliverCompletedMemoryTurn } = await import("./chat-delivery");
	const db = drizzle(sqlite, { schema });
	const offAt = new Date("2025-01-01");
	const onAt = new Date("2025-01-04");
	db.insert(schema.memoryControlIntervals)
		.values([
			{
				id: "off",
				userId: "u",
				startedAt: offAt,
				endedAt: onAt,
				enabled: false,
				epoch: 0,
			},
			{ id: "on", userId: "u", startedAt: onAt, enabled: true, epoch: 0 },
		])
		.run();
	db.update(schema.messages)
		.set({ createdAt: new Date("2025-01-02") })
		.run();
	db.update(schema.conversations).set({ projectId: null }).run();
	await deliverCompletedMemoryTurn({
		userId: "u",
		conversationId: "c",
		userMessageId: "m",
		assistantMessageId: "a",
		turnOrigin: "regenerate",
	});
	expect(db.select().from(schema.memoryBanks).get()?.scopeKey).toBe("personal");
	expect(db.select().from(schema.memorySourceRevisions).get()?.text).toBe(
		"I prefer short replies.",
	);
});
`,
};
(async () => {
	const { startVitest } = await import(
		process.cwd() + "/node_modules/vitest/dist/node.js"
	);
	const targets = [
		"src/lib/server/services/memory-profile/delivery-job.integration.test.ts",
		"src/lib/server/services/memory-context/native.test.ts",
		"src/lib/server/services/memory-profile/chat-delivery.test.ts",
	];
	const v = await startVitest(
		"test",
		targets,
		{ run: true, testNamePattern: "judge:", maxWorkers: 1 },
		{
			plugins: [
				{
					name: "synthetic-review-probes",
					enforce: "pre",
					transform(src, id) {
						const name = id.split("/").at(-1);
						if (additions[name] && targets.some((t) => id.endsWith(t)))
							return src + additions[name];
					},
				},
			],
		},
	);
	await v?.close();
})().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
