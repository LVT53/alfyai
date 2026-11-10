// Runs the four candidate labs (`*.lab.ts` beside this file) under the app's own vitest setup, so they can
// import the real search. They are not part of `npm test`: they need public datasets (LAB_DATA, or LAB_PLAN
// and LAB_PHASE for vector-recall) and take
// minutes. See docs/plans/document-ranking/README.md, "Reproduce".
//
//   LAB_DATA=<prep.py output> LAB_OUT=<empty dir> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: new URL("../../../../..", import.meta.url).pathname,
	plugins: [sveltekit() as never],
	test: {
		environment: "jsdom",
		include: ["docs/plans/document-ranking/lab/candidates/*.lab.ts"],
		globals: true,
		globalSetup: ["./src/vitest-global-setup.ts"],
		setupFiles: ["./src/vitest-setup.ts"],
	},
	resolve: {
		conditions: ["mode=test", "browser"],
		alias: [{ find: "$lib", replacement: "/src/lib" }],
	},
});
