// Add route-level cases to the migrated SQLite harness without changing product or suite files.
const fs = require("node:fs");
const path = require("node:path");
const target = "src/lib/server/services/memory-profile/migration.integration.test.ts";

(async () => {
	const { startVitest } = await import(
		process.cwd() + "/node_modules/vitest/dist/node.js"
	);
	const probes = fs.readFileSync(path.join(__dirname, "post-cutover-probes.ts.txt"), "utf8");
	const vitest = await startVitest(
		"test",
		[target],
		{ run: true, testNamePattern: "post-cutover lineage judge", maxWorkers: 1 },
		{
			plugins: [{
				name: "migration-post-cutover-lineage-regressions",
				enforce: "pre",
				transform(source, id) {
					if (id.endsWith(target)) return source + "\n" + probes;
				},
			}],
		},
	);
	await vitest?.close();
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
