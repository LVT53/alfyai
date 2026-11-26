// Re-asks the 2026-11-24 regression run's later checks with today's recall code.
//
// Every check from 2026-10-01 on comes after the profile's last source (2026-09-19), so the
// run's final SQLite and Hindsight state is exactly the state those checks read. This reruns
// the real persona tool for them on the same clock the run used, and asks the frozen answer
// function again only where the tool's content changed. Used to measure the entry-kind fix
// (memory-profile/fact-labels.ts, `entryLabels`) on its own, with nothing else moving.
// Usage: ALFYAI_BENCH_SCRATCH=<run dir> ALFYAI_BENCH_HINDSIGHT_URL=<url> node --import tsx recheck-2026-11-24.ts p01
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const id = process.argv[2] ?? "";
assert.match(id, /^p0[1-6]$/);
const scratch = process.env.ALFYAI_BENCH_SCRATCH ?? "";
assert.ok(scratch, "Set ALFYAI_BENCH_SCRATCH to the run's folder");
Object.assign(process.env, {
	DATABASE_PATH: path.join(scratch, `${id}.db`),
	SESSION_SECRET: "integrated-synthetic-memory-benchmark-only",
	HINDSIGHT_URL: process.env.ALFYAI_BENCH_HINDSIGHT_URL ?? "http://127.0.0.1:18890",
	HINDSIGHT_ALLOWED_URLS: "",
	HINDSIGHT_TENANT_KEYS: "{}",
	HINDSIGHT_TENANT_MASTER_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }),
	HINDSIGHT_TENANT_ACTIVE_KEY: "synthetic",
	HINDSIGHT_WORKER_ENABLED: "false",
	HINDSIGHT_NEW_ACCOUNTS_ENABLED: "true",
	HINDSIGHT_RESTORE_HOLD: "false",
	HINDSIGHT_CONCURRENCY: "1",
	HINDSIGHT_CURATION_MODEL: "",
	MODEL_1_NAME: "qwen3-6-27b",
	MODEL_1_BASEURL: "http://127.0.0.1:18891/v1",
	MODEL_1_API_KEY: "synthetic-local-proxy",
	MODEL_2_ENABLED: "false",
	TZ: "UTC",
});

const WallDate = Date;
let virtual = WallDate.parse("2026-10-01T12:00:00Z");
let wallStarted = WallDate.now();
class BenchDate extends WallDate {
	constructor(...args: ConstructorParameters<DateConstructor> | []) {
		super(...((args.length ? args : [BenchDate.now()]) as [number]));
	}
	static now() {
		return virtual + WallDate.now() - wallStarted;
	}
}
globalThis.Date = BenchDate as DateConstructor;

const record = JSON.parse(readFileSync(path.join(scratch, `${id}-results.json`), "utf8"));
assert.equal(record.complete, true);
const { sqlite } = await import("../../../../src/lib/server/db/index");
const { getMemoryContext } = await import("../../../../src/lib/server/services/memory-context");
const { answer } = await import("../alfyai-baseline/answer.cjs");

const lastSource = record.events
	.filter((event: { kind: string }) => event.kind === "source")
	.map((event: { day: string }) => event.day)
	.sort()
	.at(-1);
const userId = `integrated-bench-${id}`;
const out = { id, lastSource, checks: [] as unknown[] };
try {
	for (const [position, event] of record.events.entries()) {
		if (event.kind !== "check" || event.day <= lastSource) continue;
		// The run's own clock for this event: `${day}T12:00:${position}Z`.
		virtual = WallDate.parse(`${event.day}T12:00:${String(position).padStart(2, "0")}Z`);
		wallStarted = WallDate.now();
		const tool = await getMemoryContext({
			userId,
			conversationId: event.chatId,
			mode: "persona",
			query: event.query,
		});
		const changed = tool.content !== event.tool.content;
		let response;
		if (changed)
			response = await answer(
				{ lang: record.lang },
				{ day: event.day, project: event.project, query: event.query },
				{ content: tool.content },
				"alfyai-integrated-native-recheck",
			);
		out.checks.push({
			index: event.index,
			day: event.day,
			changed,
			before: { content: event.tool.content, answer: event.response?.text },
			after: changed ? { content: tool.content, answer: response?.text } : undefined,
		});
		console.log(id, event.index, changed ? "CHANGED" : "same");
	}
} finally {
	sqlite.close();
}
writeFileSync(path.join(scratch, `${id}-recheck.json`), JSON.stringify(out, null, 2) + "\n");
