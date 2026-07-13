import { config as dotenvConfig } from "dotenv";

dotenvConfig();
const KEY = process.env.PARALLEL_API_KEY;
if (!KEY) {
	console.error("PARALLEL_API_KEY missing");
	process.exit(1);
}

async function main() {
	const started = Date.now();
	const res = await fetch("https://api.parallel.ai/v1/extract", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": KEY as string },
		body: JSON.stringify({
			urls: ["https://github.com/features/copilot/plans"],
			objective:
				"What is the current monthly price in USD of GitHub Copilot Pro for individuals?",
			search_queries: ["GitHub Copilot Pro price", "Copilot Pro monthly cost"],
		}),
	});
	const text = await res.text();
	console.log(`status ${res.status} in ${Date.now() - started}ms`);
	// Print top-level keys + a trimmed view of the structure so we learn field names.
	try {
		const j = JSON.parse(text);
		console.log("top-level keys:", Object.keys(j));
		const r = (j.results || j.extracts || [])[0];
		if (r) {
			console.log("result[0] keys:", Object.keys(r));
			for (const k of Object.keys(r)) {
				const v = r[k];
				const preview = Array.isArray(v)
					? `[array len ${v.length}] ${JSON.stringify(v[0] ?? "").slice(0, 160)}`
					: typeof v === "string"
						? `"${v.slice(0, 160)}"`
						: JSON.stringify(v);
				console.log(`  ${k}: ${preview}`);
			}
		} else {
			console.log(text.slice(0, 1200));
		}
	} catch {
		console.log(text.slice(0, 1200));
	}
}

main();
