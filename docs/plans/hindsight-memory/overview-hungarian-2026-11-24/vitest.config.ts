// Runs the Overview probe (`probe.lab.ts`, beside this file) under the app's own vitest setup, so it can
// import the real `composeMemoryOverview`. It is not part of `npm test`: it calls a model (the shared bridge
// to the memory model) and needs a label for its output file. See overview-hungarian-2026-11-24.md, "Method"
// and "Config 3 round".
//
//   OVERVIEW_PROBE_LABEL=<name> npx vitest run -c docs/plans/hindsight-memory/overview-hungarian-2026-11-24/vitest.config.ts

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: new URL("../../../..", import.meta.url).pathname,
	plugins: [sveltekit() as never],
	test: {
		environment: "jsdom",
		include: [
			"docs/plans/hindsight-memory/overview-hungarian-2026-11-24/*.lab.ts",
		],
		globals: true,
		globalSetup: ["./src/vitest-global-setup.ts"],
		setupFiles: ["./src/vitest-setup.ts"],
	},
	resolve: {
		conditions: ["mode=test", "browser"],
		alias: [{ find: "$lib", replacement: "/src/lib" }],
	},
});
