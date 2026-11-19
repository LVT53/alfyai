// Run from the checkout root on Node 22. Inject cases into migrated synthetic harnesses in memory.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const receipt = process.argv.includes("--receipt");
const followup = process.argv.includes("--followup");
const targets = receipt ? {
	"memory-profile/curation.integration.test.ts": "receipt-curation.ts.txt",
	"memory-profile/dependency-repair.test.ts": "receipt-dependency.ts.txt",
} : followup ? {
	"memory-profile/curation.integration.test.ts": "followup-curation.ts.txt",
	"memory-profile/dependency-repair.test.ts": "followup-dependency.ts.txt",
} : {
	"memory-profile/curation.integration.test.ts": "curation-probes.ts.txt",
	"jobs/runner.test.ts": "engine-probes.ts.txt",
};
const services = "src/lib/server/services/";

async function run() {
	const { startVitest } = await import(
		pathToFileURL(path.resolve("node_modules/vitest/dist/node.js")).href
	);
	const vitest = await startVitest(
		"test",
		Object.keys(targets).map((target) => services + target),
		{ run: true, testNamePattern: receipt ? "receipt lifecycle judge" : followup ? "final lifecycle judge" : "fresh lifecycle judge", maxWorkers: 1 },
		{
			plugins: [
				{
					name: "fresh-lifecycle-independent-probes",
					enforce: "pre",
					transform(source, id) {
						const target = Object.keys(targets).find((name) =>
							id.endsWith(services + name),
						);
						if (!target) return;
						return source + "\n" + fs.readFileSync(
							path.join(__dirname, targets[target]),
							"utf8",
						);
					},
				},
			],
		},
	);
	await vitest?.close();
}
run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
