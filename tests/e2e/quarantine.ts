// The e2e quarantine: specs and tests the release gate does not run, each with
// the reason it is out, so a resisting test is named and visible instead of
// being deleted, skipped in the code or retried until it happens to pass.
//
// The release gate runs the WHOLE suite minus this list (`E2E_APPLY_QUARANTINE=1`,
// which `scripts/gates.sh` sets), so a new spec joins the gate by existing and
// nobody has to remember to add it. A file or a test listed here still runs when
// somebody names it: `npx playwright test tests/e2e/that.spec.ts`.
//
// Adding an entry is a decision, not a convenience: say what fails, why it is
// not a bug in the app this branch should fix, and what would let it back in.
// `tests/integration/e2e-quarantine.test.ts` refuses an entry without a reason
// or one that names a file or a test that is not there.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type QuarantinedFile = { file: string; reason: string };
export type QuarantinedTest = { file: string; title: string; reason: string };
export type Quarantine = { files: QuarantinedFile[]; tests: QuarantinedTest[] };

export const QUARANTINE_PATH = join("tests", "e2e", "quarantine.json");

export function loadQuarantine(root: string = process.cwd()): Quarantine {
	const raw = JSON.parse(readFileSync(join(root, QUARANTINE_PATH), "utf8")) as
		| Partial<Quarantine>
		| undefined;
	return { files: raw?.files ?? [], tests: raw?.tests ?? [] };
}

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Playwright `testIgnore` globs for the quarantined files (basenames are unique in tests/e2e). */
export function quarantinedFileGlobs(quarantine: Quarantine): string[] {
	return quarantine.files.map((entry) => `**/${entry.file.split("/").pop()}`);
}

/** Playwright `grepInvert` for the quarantined tests, or undefined when there are none. */
export function quarantinedTitlePattern(
	quarantine: Quarantine,
): RegExp | undefined {
	if (quarantine.tests.length === 0) return undefined;
	return new RegExp(
		quarantine.tests.map((entry) => escapeForRegExp(entry.title)).join("|"),
	);
}
