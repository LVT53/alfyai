import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The home suggestion chips are gone — the whole feature, not its rendering.
 *
 * The owner's decision was explicit: retire the chips "including their backend
 * and event log... this is a real removal, not a hiding. Delete the table with
 * a migration and remove the code that writes and reads it, rather than
 * leaving dead wiring." A dead table, a dead endpoint, or a dead i18n block
 * left behind would each be a lie about what the product does, and the next
 * reader would have to rediscover the truth from git history.
 *
 * So this file checks two things that no other test can: that the deleted
 * files are actually deleted, and that nothing left in the tree still names
 * them. It is deliberately a source scan rather than an import check — an
 * import check would pass while a route, a comment or a catalogue still
 * pointed at the removed feature.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const selfPath = fileURLToPath(import.meta.url);

/** Files the removal must take with it. */
const GONE = [
	// The rail and the server engine that fed it.
	"src/lib/components/home/HomeSuggestionRail.svelte",
	"src/lib/server/services/home-suggestions.ts",
	"src/lib/server/services/home-suggestions.test.ts",
	"src/lib/server/services/home-suggestion-rate-limit.ts",
	"src/lib/server/services/home-suggestion-rate-limit.test.ts",
	// The screenshot spec whose whole subject was the chips.
	"tests/e2e/zzz-capture-home.spec.ts",
];

/**
 * Names that may not survive anywhere in hand-written code. `drizzle/` is
 * exempt: a migration folder is a record of what the schema has been, not of
 * what it is, so the file that created the table stays on disk exactly as it
 * was written (and the file that drops it must name the table too).
 */
const FORBIDDEN = [
	"HomeSuggestionRail",
	"home-suggestion-rail",
	"home-suggestion-chip",
	"home-suggestion-another",
	"home-suggestions",
	"HomeSuggestionEvent",
	"recordHomeSuggestionEvent",
	"isHomeSuggestionCandidateKey",
	"checkHomeSuggestionEventRateLimit",
	"homeSuggestionEvents",
	"home_suggestion_events",
	"home.suggest",
	"composeIntoComposer",
];

const SCANNED_DIRS = ["src", "tests", "scripts"];
const SKIPPED_DIRS = new Set([
	"node_modules",
	".svelte-kit",
	".git",
	"build",
	"data",
	"test-results",
	"playwright-report",
]);
/** Extensions that can carry live wiring; snapshots and binaries cannot. */
const SCANNED_EXTENSIONS = [".ts", ".svelte", ".js", ".json", ".sql", ".css"];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIPPED_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function sources(): string[] {
	return SCANNED_DIRS.flatMap((dir) => walk(join(repoRoot, dir))).filter(
		(file) =>
			file !== selfPath &&
			SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension)),
	);
}

describe("home suggestion removal", () => {
	it.each(GONE)("no longer has %s", (path) => {
		expect(existsSync(join(repoRoot, path))).toBe(false);
	});

	it("leaves no live reference to the removed feature", () => {
		const hits: string[] = [];
		for (const file of sources()) {
			const text = readFileSync(file, "utf8");
			for (const needle of FORBIDDEN) {
				if (text.includes(needle)) {
					hits.push(`${relative(repoRoot, file)}: ${needle}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});

	it("drops the event table from the schema and from the table registries", () => {
		const schema = readFileSync(
			join(repoRoot, "src", "lib", "server", "db", "schema.ts"),
			"utf8",
		);
		expect(schema).not.toContain("homeSuggestionEvents");
		expect(schema).not.toContain("home_suggestion_events");

		const prepareDb = readFileSync(
			join(repoRoot, "scripts", "prepare-db.ts"),
			"utf8",
		);
		expect(prepareDb).not.toContain("home_suggestion_events");

		const scopedTables = readFileSync(
			join(
				repoRoot,
				"src",
				"lib",
				"server",
				"services",
				"account-lifecycle",
				"user-scoped-tables.ts",
			),
			"utf8",
		);
		expect(scopedTables).not.toContain("home_suggestion_events");
	});

	it("drops the table with a journaled migration, because the table must not outlive the code", () => {
		const journal = JSON.parse(
			readFileSync(join(repoRoot, "drizzle", "meta", "_journal.json"), "utf8"),
		) as { entries: Array<{ idx: number; tag: string }> };
		const drop = journal.entries.find((entry) =>
			entry.tag.endsWith("_drop_home_suggestion_events"),
		);
		expect(drop).toBeDefined();
		// A drop that reused an existing number would be applied by filename but
		// counted twice by idx: the highest idx must be this migration's.
		expect(drop?.idx).toBe(
			Math.max(...journal.entries.map((entry) => entry.idx)),
		);

		const sql = readFileSync(
			join(repoRoot, "drizzle", `${drop?.tag}.sql`),
			"utf8",
		);
		expect(sql).toContain("DROP TABLE IF EXISTS `home_suggestion_events`");
	});

	it("forgets the chip keys in both locales", () => {
		const chat = readFileSync(
			join(repoRoot, "src", "lib", "i18n", "chat.ts"),
			"utf8",
		);
		expect(chat).not.toContain("home.suggest");
		// The strings the board keeps must not have been swept up with them.
		expect(chat).toContain("home.recentLabel");
		expect(chat).toContain("home.memoryReview.");
	});
});
