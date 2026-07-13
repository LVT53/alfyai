import { config as dotenvConfig } from "dotenv";

dotenvConfig();
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { readFileSync } from "node:fs";
import path from "node:path";

// Tests the two-tool design: does Turbo-search + Extract beat Turbo-search alone
// on questions where the answer lives inside a page (not in the search excerpt)?

const ANSWER_SYSTEM = `You are answering a user's question using ONLY the provided web search results below. Rules:
- Use only the information in the provided results; do not rely on prior knowledge.
- Cite at least one source by including its URL.
- If the results do not contain the answer, say you could not find it. Do not guess.
- Be concise: 1-4 sentences.`;

async function main() {
	const key = process.env.PARALLEL_API_KEY;
	if (!key) throw new Error("PARALLEL_API_KEY missing");

	const { searchParallel, extractParallel } = await import("./lib/parallel-client");
	const grounding = await import("./lib/grounding");
	const modelLib = await import("./lib/model");

	const doc = JSON.parse(
		readFileSync(path.join("scripts", "search-benchmark", "questions.json"), "utf8"),
	);
	// Depth-sensitive questions: a specific value that tends to live inside a page.
	const ids = (process.env.PROBE_IDS ?? "A1,D2,D4,C1").split(",");
	const qs = doc.questions.filter((q: { id: string }) => ids.includes(q.id));

	const flash = await modelLib.resolveModelClient({
		providerName: "deepseek",
		apiModelName: "deepseek-v4-flash",
		requireKey: true,
	});
	if (!flash) throw new Error("no flash client");
	const judge = await modelLib.resolveJudge();
	if (!judge) throw new Error("no judge");

	for (const q of qs) {
		console.log(`\n${"=".repeat(78)}\n${q.id} [${q.tier}] ${q.question}`);
		console.log(`GOLD: ${q.gold_answer}`);

		// 1. Turbo search
		const turbo = await searchParallel({
			objective: q.question,
			searchQueries: [q.question],
			mode: "turbo",
			apiKey: key,
		});
		const topUrls = turbo.results.slice(0, 3).map((r) => r.url);
		const turboContext = grounding.buildParallelContext(turbo);

		// 2. Extract on the top URLs
		const extract = await extractParallel({
			urls: topUrls,
			objective: q.question,
			searchQueries: [q.question],
			apiKey: key,
		});
		const extractContext = extract.results
			.map((r, i) => {
				const body = (r.excerpts || []).join("\n").trim() || r.full_content || "(none)";
				return `[E${i + 1}] ${r.title}\n${r.url}\n${body}`;
			})
			.join("\n\n")
			.slice(0, 24000);

		console.log(
			`  turbo: ${turbo.results.length} results in ${turbo.latencyMs}ms | extract: ${extract.results.length} pages in ${extract.latencyMs}ms${extract.error ? ` (ERR ${extract.error})` : ""}`,
		);

		// 3. Answer both ways
		const ansTurbo = await modelLib.callModel(flash, {
			system: ANSWER_SYSTEM,
			user: `Question: ${q.question}\n\nWeb search results:\n${turboContext}`,
		});
		const ansBoth = await modelLib.callModel(flash, {
			system: ANSWER_SYSTEM,
			user: `Question: ${q.question}\n\nWeb search results (excerpts):\n${turboContext}\n\nDeep page extracts:\n${extractContext}`,
		});

		// 4. Judge both
		const jTurbo = await modelLib.judgeAnswer(judge, {
			question: q.question,
			goldAnswer: q.gold_answer,
			gradingNotes: q.grading_notes,
			candidateAnswer: ansTurbo.text,
		});
		const jBoth = await modelLib.judgeAnswer(judge, {
			question: q.question,
			goldAnswer: q.gold_answer,
			gradingNotes: q.grading_notes,
			candidateAnswer: ansBoth.text,
		});

		console.log(
			`  TURBO-ONLY     score=${jTurbo.score}  ${ansTurbo.text.replace(/\n/g, " ").slice(0, 150)}`,
		);
		console.log(
			`  TURBO+EXTRACT  score=${jBoth.score}  ${ansBoth.text.replace(/\n/g, " ").slice(0, 150)}`,
		);
		console.log(
			`  => delta ${jBoth.score - jTurbo.score >= 0 ? "+" : ""}${jBoth.score - jTurbo.score}  (extract added ${extract.latencyMs}ms)`,
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
