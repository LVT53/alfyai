// Run from the repo root on Node 22. Inject only synthetic cases into the existing test harness.
const fs = require("node:fs");
const path = require("node:path");
const folder = "src/lib/server/services/memory-profile/";
const targets = {
	"dependency-repair.test.ts": "dependency-probes.ts.txt",
	"curation.integration.test.ts": "curation-probes.ts.txt",
};
(async () => {
	const { startVitest } = await import(process.cwd() + "/node_modules/vitest/dist/node.js");
	const v = await startVitest("test", Object.keys(targets).map(f => folder + f), {
		run: true, testNamePattern: "lifecycle judge", maxWorkers: 1,
	}, { plugins: [{
		name: "lifecycle-independent-regressions", enforce: "pre",
		transform(source, id) {
			const target = Object.keys(targets).find(f => id.endsWith(folder + f));
			if (target) return source + "\n" + fs.readFileSync(path.join(__dirname, targets[target]), "utf8");
		},
	}] });
	await v?.close();
})().catch(error => {console.error(error); process.exitCode = 1;});
