#!/usr/bin/env tsx
//
// The artifact-contract eval harness's live orchestration script (Feature 2
// · Artifacts). This slice ships a skeleton only (decisions.md ruling 44):
// no suite is registered yet (cases.ts is empty) and no model endpoint
// configuration exists yet (that is Slice 5a's config.ts/client.ts). This
// script's one job here is the shape every later slice's suite runs
// through: resolve `--suite`, look the suite up in the case registry, and
// exit 0 with a clear explanation when there is nothing to run — never a
// hard failure, and never a dependency of `npm test` or `npm run build`.
//
// Run with: npx tsx scripts/eval-artifact-contracts/run.ts --suite <name>

import process from "node:process";
import { EVAL_CASES } from "./cases";

function parseSuiteFlag(argv: string[]): string | null {
	const index = argv.indexOf("--suite");
	if (index === -1 || index + 1 >= argv.length) return null;
	return argv[index + 1];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const suite = parseSuiteFlag(argv);

	if (!suite) {
		console.log(
			"[eval-artifact-contracts] No --suite given. Nothing to run. " +
				"Pass --suite <name> once a type slice has registered one in cases.ts.",
		);
		return;
	}

	const cases = EVAL_CASES[suite];
	if (!cases || cases.length === 0) {
		console.log(
			`[eval-artifact-contracts] No cases are registered for suite "${suite}" yet. ` +
				"This is the Slice 0 skeleton: each type slice appends its own suite " +
				"(document, app, verification, canvas, slides) as it lands. Exiting 0.",
		);
		return;
	}

	// Live model orchestration (resolving an endpoint, sending each case,
	// scoring the response) arrives with Slice 5a's config.ts/client.ts —
	// this skeleton does not talk to a model.
	console.log(
		`[eval-artifact-contracts] Suite "${suite}" has ${cases.length} case(s) registered, ` +
			"but this skeleton has no model client yet (Slice 5a). Exiting 0.",
	);
}

main().catch((error) => {
	console.error("[eval-artifact-contracts] Unexpected error:", error);
	process.exitCode = 1;
});
