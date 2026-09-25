import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergedDictionaryModules } from "../src/lib/i18n.test-helpers";

// Guards for scripts/validate-i18n.ts.
//
// That script reads the dictionary files as text and counts the keys it can
// parse, so it can be wrong in the quiet direction in two ways: it can read a
// namespace that ships and not watch it, and it can fail to recognise a value
// and count the key as absent. Both were live: the module list was kept by
// hand and had drifted off `instructions`, `projects`, `connections` and
// `legal`, and the value regex only matched double-quoted and backticked
// strings, so single-quoted values were invisible.
//
// Counting the same dictionaries as real module objects — not by parsing their
// source text a second time — is what makes these tests able to tell. The
// validator's number and this number agree only if it read everything.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");

type DictionaryModule = {
	en: Record<string, string>;
	hu: Record<string, string>;
};

// The colocated `*.test.ts` files are excluded: importing them eagerly would
// run their suites inside this one.
const importedModules = import.meta.glob(
	["../src/lib/i18n/*.ts", "!../src/lib/i18n/*.test.ts"],
	{ eager: true },
) as Record<string, { default?: DictionaryModule }>;

function dictionariesOnDisk(): Array<{
	name: string;
	dictionary: DictionaryModule;
}> {
	return Object.entries(importedModules)
		.map(([modulePath, moduleExports]) => ({
			name: modulePath.split("/").pop()?.replace(/\.ts$/, "") ?? modulePath,
			dictionary: moduleExports.default,
		}))
		.filter(
			(entry): entry is { name: string; dictionary: DictionaryModule } =>
				typeof entry.dictionary?.en === "object" &&
				typeof entry.dictionary?.hu === "object",
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

let reportedTotals: { en: number; hu: number } | null = null;

function validatorReportedTotals(): { en: number; hu: number } {
	if (reportedTotals) return reportedTotals;

	// Run the local binary rather than `npx`, which could reach for a registry
	// copy of tsx when the devDependency is missing — a different script then,
	// or none at all, and this guard would be measuring the wrong thing.
	if (!existsSync(TSX_BIN)) {
		throw new Error(
			`tsx is missing at ${TSX_BIN}. These tests cannot check the validator's coverage without it.`,
		);
	}

	let report = "";
	try {
		report = execFileSync(TSX_BIN, ["scripts/validate-i18n.ts"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
	} catch (error) {
		// Exit 1 means the validator found translation errors, which is a
		// different claim than this file makes. Its report is still on stdout.
		const failure = error as { stdout?: string; status?: number };
		if (failure.stdout === undefined) {
			throw new Error(
				`The i18n validator exited with ${failure.status} and printed nothing to check.`,
			);
		}
		report = failure.stdout;
	}

	const en = /Total EN keys:\s*(\d+)/.exec(report);
	const hu = /Total HU keys:\s*(\d+)/.exec(report);
	if (!en || !hu) {
		throw new Error(
			`The i18n validator no longer prints its key totals, so this guard cannot read its coverage:\n${report}`,
		);
	}

	reportedTotals = { en: Number(en[1]), hu: Number(hu[1]) };
	return reportedTotals;
}

describe("scripts/validate-i18n.ts coverage", () => {
	it("has a dictionary file for every module it watches, and no unwatched one", () => {
		const watched = mergedDictionaryModules();
		const onDisk = dictionariesOnDisk().map((entry) => entry.name);

		// Two directions, one claim: the modules the app merges are exactly the
		// dictionary files that exist. A file here and not there is a
		// dictionary nobody merges; a merge with no file is a namespace the
		// app ships and cannot read.
		expect(onDisk).toEqual(watched);
	});

	it("counts every key those modules hold, EN and HU", () => {
		const modules = dictionariesOnDisk();
		const expected = modules.reduce(
			(total, entry) => ({
				en: total.en + Object.keys(entry.dictionary.en).length,
				hu: total.hu + Object.keys(entry.dictionary.hu).length,
			}),
			{ en: 0, hu: 0 },
		);

		const breakdown = modules
			.map(
				(entry) =>
					`${entry.name}: ${Object.keys(entry.dictionary.en).length}/${Object.keys(entry.dictionary.hu).length}`,
			)
			.join(", ");

		const reported = validatorReportedTotals();

		// A mismatch of 1 is enough to mean the validator is reading the
		// dictionaries less well than it claims; the per-module breakdown rides
		// in the message so the namespace that went missing is visible without
		// re-counting by hand.
		expect(
			reported.en,
			`validator EN total vs the dictionary modules — ${breakdown}`,
		).toBe(expected.en);
		expect(
			reported.hu,
			`validator HU total vs the dictionary modules — ${breakdown}`,
		).toBe(expected.hu);
	}, 30_000);
});
