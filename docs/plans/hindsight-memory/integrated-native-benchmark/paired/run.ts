import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { estimateTokenCount } from "../../../../../src/lib/utils/tokens";
import { answer } from "../../alfyai-baseline/answer.cjs";

const id = process.argv[2] ?? "";
assert.match(id, /^p0[1-6]$/);
assert.equal(process.argv.length, 3);
const root = "docs/plans/hindsight-memory/integrated-native-benchmark";
const sourceArchive = readFileSync(`${root}/${id}-results.json.gz`);
const archived = JSON.parse(gunzipSync(sourceArchive).toString());
assert.equal(archived.id, id);
assert.equal(archived.complete, true);
const budget = 8_000; // The recorded app persona tool's total row-text budget.
const sha256 = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
const archiveHash = sha256(sourceArchive);
const runnerHash = sha256(readFileSync(`${root}/paired/run.ts`));
const answerHash = sha256(readFileSync("docs/plans/hindsight-memory/alfyai-baseline/answer.cjs"));
const output = `/tmp/alfyai-integrated-memory/paired/${id}-results.json`;
const result = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {
	id, archiveHash, runnerHash, answerHash, budget, checks: [],
};
assert.equal(result.archiveHash, archiveHash);
assert.equal(result.runnerHash, runnerHash);
assert.equal(result.answerHash, answerHash);
function save() {
	const pending = `${output}.${process.pid}.tmp`;
	writeFileSync(pending, JSON.stringify(result, null, 2) + "\n");
	renameSync(pending, output);
}

type Fingerprint = { id: string; text: string };
const known = new Map<string, {
	bankId: string; sourceId: string; assertedAt: string; day: string; text: string;
}>();
for (const event of archived.events) {
	if (event.kind === "source") {
		assert.equal(event.source.state, "accepted");
		assert.equal(event.source.assertedAt.slice(0, 10), event.day);
		for (const fact of event.source.facts) {
			assert.ok(!known.has(fact.id));
			known.set(fact.id, {
				bankId: event.source.bankId,
				sourceId: event.source.id,
				assertedAt: event.source.assertedAt,
				day: event.day,
				text: fact.text,
			});
		}
		continue;
	}
	assert.equal(event.kind, "check");
	// These are the two already-frozen scenario families dependent on Atlas.
	if (event.index === 9 || event.index === 10) continue;
	if (result.checks.some((record: {index: number}) => record.index === event.index)) continue;
	const scoped = ["personal", ...(event.project ? [`project:integrated-bench-${id}-${event.project}`] : [])];
	const admitted = event.tool.evidenceCandidates.map((candidate: {
		metadata: {memoryItemId: string; generation: string};
	}) => {
		const bank = event.published.find((bank: {
			scopeKey: string; generation: string; published: Fingerprint[];
		}) => scoped.includes(bank.scopeKey) && bank.generation === candidate.metadata.generation &&
			bank.published.some((row) => row.id === candidate.metadata.memoryItemId));
		assert.ok(bank, "Observation must be allowed and present in this checkpoint.");
		return {
			bank,
			row: bank.published.find((row: Fingerprint) => row.id === candidate.metadata.memoryItemId),
		};
	});
	const exactAppText = admitted.map(({row}: { row: Fingerprint }) => `- ${row.text}`).join("\n");
	assert.equal(exactAppText, event.tool.content);
	const rawFacts = new Map<string, NonNullable<ReturnType<typeof known.get>>>();
	for (const { bank, row } of admitted) {
		for (const fingerprint of row.fingerprints as Fingerprint[]) {
			const source = known.get(fingerprint.id);
			assert.ok(source, "Referenced raw fact must have occurred earlier in this profile's ledger.");
			assert.equal(source.text, fingerprint.text);
			assert.equal(source.bankId, bank.bankId);
			assert.ok(source.day <= event.day);
			rawFacts.set(fingerprint.id, source);
		}
	}
	const evidence = {
		observation: event.tool.content,
		linkedRaw: [...rawFacts.values()].map(({text}) => `- ${text}`).join("\n"),
	};
	const rowTokens = {
		observation: admitted.reduce((sum: number, {row}: {row: Fingerprint}) => sum + estimateTokenCount(row.text), 0),
		linkedRaw: [...rawFacts.values()].reduce((sum, {text}) => sum + estimateTokenCount(text), 0),
	};
	assert.ok(rowTokens.observation <= budget && rowTokens.linkedRaw <= budget);
	const order = event.index % 2 ? ["linkedRaw", "observation"] : ["observation", "linkedRaw"];
	const responses: Record<string, unknown> = {};
	for (const arm of order as ("observation" | "linkedRaw")[]) {
		try {
			responses[arm] = await answer(
				{ lang: archived.lang },
				{ day: event.day, project: event.project, query: event.query },
				{ content: evidence[arm] },
				`paired-${arm}`,
			);
		} catch (error) {
			responses[arm] = { error: String(error) };
		}
	}
	result.checks.push({
		index: event.index, day: event.day, project: event.project, query: event.query,
		order, evidence, evidenceSha256: {
			observation: sha256(evidence.observation),
			linkedRaw: sha256(evidence.linkedRaw),
		},
		modelRowTokens: rowTokens,
		sourceRefs: [...rawFacts].map(([factId, { sourceId, bankId, assertedAt }]) =>
			({ factId, sourceId, bankId, assertedAt })),
		responses,
	});
	save();
	console.log(id, event.index, order.join("/"));
}
assert.equal(result.checks.length, 10);
result.complete = true;
save();
