// Run with node --import tsx against a disposable clone of the synthetic app DB.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { getDatabasePath } from "$lib/server/env";
import type { NativeMemory } from "$lib/server/services/memory-profile/contracts";
const sampleWriter = `
	const Database = require("better-sqlite3");
	const db = new Database(process.argv[1], { fileMustExist: true, timeout: 10000 });
	const write = db.prepare("UPDATE users SET updated_at = updated_at WHERE id = ?");
	let latency = [];
	const timer = setInterval(() => {
		const start = performance.now();
		write.run(process.argv[2]);
		latency.push(performance.now() - start);
	}, 2);
	process.send("ready");
	process.on("message", (command) => {
		if (command === "sample") {
			process.send(latency);
			latency = [];
		} else if (command === "stop") {
			clearInterval(timer);
			db.close();
			process.disconnect();
		}
	});
`;

function summary(values: number[]) {
	assert(values.length);
	const sorted = [...values].sort((a, b) => a - b);
	const ms = (value: number) => Number(value.toFixed(3));
	return {
		samples: sorted.length,
		p50Ms: ms(sorted[Math.floor((sorted.length - 1) * 0.50)]),
		p95Ms: ms(sorted[Math.floor((sorted.length - 1) * 0.95)]),
		maxMs: ms(sorted[sorted.length - 1]),
	};
}

async function main() {
	// Validate this before making the first write. The benchmark mutates only
	// a throwaway clone of the synthetic acceptance database.
	const database = getDatabasePath();
	assert(database.startsWith("/tmp/alfyai-nativeops-capacity-"));
	const { db, sqlite } = await import("$lib/server/db");
	const { memorySourceRevisions, users } = await import("$lib/server/db/schema");
	const { ensureMemoryBank, recordMemorySource } = await import("$lib/server/services/memory-profile/revisions");
	const { prepareNativeSnapshot, publishNativeSnapshot, readPublishedMemory } = await import("$lib/server/services/memory-profile/publication");
	const owner = db.select().from(users).where(eq(users.email, "memory-acceptance@example.test")).get();
	assert(owner, "Expected the synthetic acceptance account");
	const bank = ensureMemoryBank(owner.id, { kind: "personal" });
	const writer = spawn(process.execPath, ["-e", sampleWriter, database, owner.id], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const sample = async () => {
		const next = once(writer, "message");
		writer.send("sample");
		return summary((await next)[0] as number[]);
	};
	try {
		assert.equal((await once(writer, "message"))[0], "ready");
		await pause(200);
		const baseline = await sample();
		let revision = bank.revision;
		const series = [];
		for (const size of [128, 512, 2048]) {
			const source = recordMemorySource({
				userId: owner.id,
				bankId: bank.id,
				epoch: bank.epoch,
				eventId: "capacity-" + size,
				lineageId: "capacity-" + size,
				text: "Synthetic publication capacity fixture " + size,
				context: "",
				assertedAt: new Date("2026-11-18T12:00:00Z"),
			});
			const facts = Array.from({ length: size }, (_, index) => ({
				id: `fact-${size}-${index}`,
				text: `The synthetic owner's notebook item number is ${index}.`,
				document_id: source.id,
				consolidated_at: "2026-11-18T12:00:00Z",
				fact_type: "world",
			}));
			db.update(memorySourceRevisions).set({
				state: "accepted", acknowledgedFactsJson: JSON.stringify(facts),
			}).where(eq(memorySourceRevisions.id, source.id)).run();
			const observations: NativeMemory[] = facts.map((fact) => ({
				id: "observation-" + fact.id,
				text: fact.text,
				fact_type: "observation",
				source_memory_ids: [fact.id],
			}));
			const memories = [...facts, ...observations];
			const preparation: number[] = [];
			const writes: number[] = [];
			await sample();
			for (let round = 0; round < 7; round++) {
				let start = performance.now();
				const prepared = prepareNativeSnapshot(memories);
				preparation.push(performance.now() - start);
				start = performance.now();
				db.transaction((tx) => publishNativeSnapshot(tx, {
					userId: owner.id,
					bankId: bank.id,
					epoch: bank.epoch,
					expectedRevision: revision++,
					memories,
					prepared,
				}));
				writes.push(performance.now() - start);
				await pause(25);
			}
			const contention = await sample();
			assert.equal(readPublishedMemory(owner.id, bank.id).length, size);
			series.push({
				published: size,
				preparation: summary(preparation),
				writeTransaction: summary(writes),
				independentWriter: contention,
			});
		}
		const result = { baseline, series };
		writeFileSync("/tmp/alfyai-nativeops-publication-capacity.json", JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result));
	} finally {
		writer.send("stop");
		await once(writer, "exit");
		sqlite.close();
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
