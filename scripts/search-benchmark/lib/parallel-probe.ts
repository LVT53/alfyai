import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const KEY = process.env.PARALLEL_API_KEY;
if (!KEY) {
	console.error("PARALLEL_API_KEY missing from env");
	process.exit(1);
}

const ENDPOINT = "https://api.parallel.ai/v1/search";

async function call(mode: string, label: string, truncate = 2600) {
	const started = Date.now();
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": KEY as string,
			},
			body: JSON.stringify({
				objective:
					"Find the default TCP port number that a stock PostgreSQL server listens on.",
				search_queries: [
					"PostgreSQL default port number",
					"postgres listen port 5432",
				],
				mode,
			}),
		});
		const text = await res.text();
		console.log(
			`\n=== mode="${mode}" (${label}) -> status ${res.status} in ${Date.now() - started}ms ===`,
		);
		console.log(text.slice(0, truncate));
	} catch (error) {
		console.log(`\n=== mode="${mode}" (${label}) -> ERROR ===`, String(error));
	}
}

async function main() {
	// Full turbo response so we can see the exact result shape.
	await call("turbo", "expected fast tier");
	// Probe which deep-mode enum is valid (docs disagree: base/pro vs basic/advanced).
	for (const mode of ["base", "basic", "pro", "advanced"]) {
		await call(mode, "enum probe", 260);
	}
}

main();
