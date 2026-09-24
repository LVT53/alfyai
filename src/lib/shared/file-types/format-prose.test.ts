// Model-facing prose consistency (spec section 6.4, slice E).
//
// The `produce_file` / `read_generated_file` tool descriptions and the
// `produce_file` lines in `prompts.ts` are HAND-WRITTEN and stay that way.
// They sit inside the local model's cached prompt prefix (Flash-Next caches on
// 1600-token blocks), so a one-character change evicts every cached prefix for
// every user. This file is the alternative to generating them:
//
//   1. frozen copies, asserted byte-for-byte, so an accidental edit is loud;
//   2. every format the prose names is a type the registry knows, and — for
//      the produce_file prose — one `produce_file` can actually make;
//   3. the EN and HU descriptions name the SAME formats, which nothing
//      checked before (spec section 7, "HU tool description drift").
//
// Slice P6-D took that eviction, once, for the whole MinerU 4 migration, so
// the disagreements this file used to record as KNOWN_PROSE_EXCEPTIONS are
// gone except `.xls`, which only the unchangeable migration baseline names.
// A new exception is not a way to land prose that is not true: the frozen
// copies below are re-frozen deliberately, in the commit that changes them.
//
// Workspaces Slice E re-froze read_generated_file's two copies for one clause:
// a project's files are read by naming them, because the Project Files section
// is a catalogue and not content. The clause was paid for inside the same
// description (read_generated_file sits 7 tokens under the en catalogue
// ceiling), and neither new copy names a format the registry does not know.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	isSupportedFileProductionOutputType,
} from "./production";
import { FILE_TYPE_ENTRIES } from "./table";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");

function read(relative: string): string {
	return readFileSync(path.join(root, relative), "utf8");
}

const PROMPTS = read("src/lib/server/prompts.ts");
const TOOLS = read("src/lib/server/services/normal-chat-tools/index.ts");
const USER_SKILLS = read("src/lib/server/services/skills/user-skills.ts");
const SKILL_FIXTURES = read("scripts/skill-eval-fixtures.ts");
const SOURCE_SCHEMA = read(
	"src/lib/server/services/file-production/source-schema.ts",
);

// ───────────────────────────────────────────────────────────────────────────
// Known exceptions — real disagreements between today's prose and today's
// code. Each one is a finding for a later phase, not a licence to drift.
// ───────────────────────────────────────────────────────────────────────────

const KNOWN_PROSE_EXCEPTIONS = {
	/**
	 * Formats the built-in skill prose names that the registry knows but
	 * `produce_file` cannot produce. `.xls` is legacy-Excel: recognised on
	 * upload and never generated, and it is named only by the frozen
	 * migration baseline, which cannot be reworded.
	 *
	 * `.tsv` left this set in slice P6-D — it is now a real direct-text
	 * upload and a requestable output. Shrinking the set is the only allowed
	 * direction; a new entry means the prose is promising something the
	 * registry does not have.
	 */
	nonRequestableSkillFormats: new Set(["xls"]),
} as const;

// ───────────────────────────────────────────────────────────────────────────
// FROZEN copies of the cached-prefix prose
// ───────────────────────────────────────────────────────────────────────────

/** src/lib/server/prompts.ts:156 — the produce_file row of the tool table. */
const FROZEN_PROMPTS_PRODUCE_FILE_ROW =
	"| produce_file | Create durable downloadable files | PDFs, reports, DOCX, HTML, CSV, Excel, PowerPoint, JSON, ZIP, and other generated artifacts |";

/** src/lib/server/prompts.ts:188-189 — the produce_file mode guidance. */
const FROZEN_PROMPTS_PRODUCE_FILE_GUIDANCE = [
	"For polished PDF/DOCX/HTML reports, simple markdown or content is enough unless tables, charts, or custom layout are essential. Use documentSource only when structured blocks materially improve the document.",
	"Use program only for artifacts that genuinely require executable generation such as XLSX, PPTX, ZIP, or custom packaged files.",
];

/** src/lib/server/services/normal-chat-tools/index.ts:306 (EN produce_file). */
const FROZEN_EN_PRODUCE_FILE =
	"Create a downloadable file (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Call it only when the user asks for a file, after dependent tools have returned real content — never placeholder or empty content. Do not use it to work the data out (run_python first), to read a file back (read_generated_file), or when no download was asked for — a summary, table or list belongs in your reply. Simple form: `requestTitle`, `filename` or `outputType`, and `markdown`; the server picks the production mode. Do not mix PDF/DOCX/HTML with md/txt/csv/tsv/json/code in one request; call twice. To change an existing file, call `read_generated_file` first, then resend it in full or send `patches` [{oldText, newText}] with each oldText an exact, unique excerpt of 20+ characters. Use `program` only for artifacts that need code to build (XLSX, PPTX, ZIP): name the type in `outputType`/`requestedOutputs`, and the code must write into `/output` (e.g. `/output/report.xlsx`) — a bare filename is lost. Use `documentSource` blocks only when structure clearly improves a PDF/DOCX/HTML report: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|stackedBar|line|area|pie|scatter|donut,title,labelKey,valueKey,seriesKey(stackedBar only),data:[{label,value}]}, code{language,text}, callout{tone,text}. Never draw tables or charts as text (no pipe tables, no block-character bars); encode line breaks as \\n in JSON strings. Returns `status`: `succeeded` with `files` — only then say the file is ready; `failed` with `errorCode`/`message` — if `retryable`, fix it and resubmit once, else say plainly why it failed; `running` — still being made, not ready.";

/** src/lib/server/services/normal-chat-tools/index.ts:403 (HU produce_file). */
const FROZEN_HU_PRODUCE_FILE =
	"Letölthető fájl készítése (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Csak akkor hívd, ha a felhasználó fájlt kér, és a függő eszközök már valódi tartalmat adtak vissza — soha ne helyőrzővel vagy üresen. Ne használd magának az adatnak a kidolgozására (előbb run_python), fájl visszaolvasására (read_generated_file), és akkor sem, ha nem kértek letöltést — egy összefoglaló, táblázat vagy lista a válaszodban a helye. Egyszerű forma: `requestTitle`, `filename` vagy `outputType`, és `markdown`; az előállítási módot a szerver választja. Egy kérésben ne keverd a PDF/DOCX/HTML formátumokat az md/txt/csv/tsv/json/code fájlokkal; hívd meg kétszer. Meglévő fájl módosításához előbb hívd a `read_generated_file`-t, majd küldd újra a teljes tartalmat, vagy adj `patches`-t [{oldText, newText}], ahol minden oldText pontos, egyedi, legalább 20 karakteres részlet. A `program`-ot csak kódot igénylő fájlokhoz használd (XLSX, PPTX, ZIP): a típust add meg az `outputType`/`requestedOutputs` mezőben, a kód pedig a `/output` könyvtárba írja a fájlt (pl. `/output/report.xlsx`) — a puszta fájlnév a `/output`-on kívülre kerül és elvész. `documentSource` blokkokat csak akkor, ha a struktúra egyértelműen javít egy PDF/DOCX/HTML riportot: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|stackedBar|line|area|pie|scatter|donut,title,labelKey,valueKey,seriesKey(stackedBar only),data:[{label,value}]}, code{language,text}, callout{tone,text}. Soha ne rajzolj táblázatot vagy diagramot szövegként (nincs pipe-táblázat, nincs blokk-karakteres sáv); a sortöréseket \\n-ként kódold a JSON szövegekben. `status`-t ad vissza: `succeeded` a `files` listával — csak ekkor mondd, hogy kész; `failed` `errorCode`/`message` mezőkkel — ha `retryable`, javítsd és küldd be még egyszer, különben mondd meg, miért nem sikerült; `running` — még készül, nincs kész fájl.";

/** src/lib/server/services/normal-chat-tools/index.ts:311 (EN read_generated_file). */
const FROZEN_EN_READ_GENERATED_FILE =
	"Read a file's full current text in THIS conversation or its project — one produced here, one uploaded or linked here (under Conversation Files), or one linked to the project (under Project Files) — by `filename` or `requestTitle`. Name a project's file to read it: that list only says it exists. Call it before `produce_file` patches (a non-exact oldText is rejected), or when the user wants more of a document than your context shows. Long text arrives in windows: on `hasMore`, call again with `from: nextFrom`. Pass `query` for up to 3 passages about a topic instead of the window. For a paged document pass `page`; excerpts carry citable `[p. 3]`/`[slide 2]` markers. Do not use it for connected cloud storage (files), web pages (fetch_url), remembered preferences (memory_context), or a passage already quoted in your context. Returns text with `hasMore`/`nextFrom`, or not found / ambiguous (several files match — retry with one exact name); say so, don't guess.";

/** src/lib/server/services/normal-chat-tools/index.ts:408 (HU read_generated_file). */
const FROZEN_HU_READ_GENERATED_FILE =
	"Egy EBBEN a beszélgetésben vagy a beszélgetés projektjében lévő fájl teljes aktuális szövegének beolvasása — itt előállított fájlé, ide feltöltött/csatolt dokumentumé (a Conversation Files alatti nevek), vagy a projekthez kapcsolt fájlé (a Project Files alatti nevek) — `filename` vagy `requestTitle` alapján. A projekt fájlját közvetlenül a nevével olvasod ki: az a lista csak azt mondja meg, hogy létezik. Hívd meg, mielőtt `produce_file` patch-eket küldenél (a pontosan nem egyező oldText-ű patch-et a szerver elutasítja), vagy ha a felhasználó többet kér egy dokumentumból, mint amennyit a kontextusod mutat. A hosszú szöveg ablakokban érkezik: ha az eredményben `hasMore` áll, hívd újra `from: nextFrom` értékkel. A `query` megadásával az ablak helyett annak az egy fájlnak legfeljebb 3, a témához tartozó részletét kapod. Oldalszámozott dokumentumnál a `page` megadásával onnan indul az olvasás; a kontextusodban lévő részletek `[p. 3]`/`[slide 2]` jelölései idézhetők. Ne használd csatlakoztatott felhőtárhoz (files), weboldalhoz (fetch_url), megjegyzett preferenciákhoz (memory_context), sem akkor, ha a szükséges részlet már idézve van a kontextusodban. Szöveget ad vissza `hasMore`/`nextFrom` mezőkkel, vagy azt, hogy nincs meg / több fájl is egyezik (akkor hívd újra egy pontos névvel); ilyenkor mondd ki, ne találgass.";

// ───────────────────────────────────────────────────────────────────────────
// Extraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * The two `description:` literals for one tool inside `TOOL_I18N`, in source
 * order: EN first, HU second. Reading the source rather than importing the
 * module keeps this test free of the chat runtime's dependency graph, the same
 * trade-off `no-ad-hoc-maps.test.ts` makes.
 */
function toolDescriptions(tool: string): string[] {
	const pattern = new RegExp(
		String.raw`\b${tool}: \{\s*description:\s*("(?:[^"\\]|\\.)*"),`,
		"g",
	);
	return [...TOOLS.matchAll(pattern)].map(
		(match) => JSON.parse(match[1]) as string,
	);
}

/** Upper-case format names and dotted extensions a prose string may name. */
const FORMAT_TOKEN =
	/\b(PDFs?|DOCX|XLSX|XLS|PPTX|CSV|TSV|ZIP|JSON|HTML|Markdown|Excel|PowerPoint)\b|\.(pdf|docx|xlsx|xls|pptx|csv|tsv|zip|json|html|md|markdown|txt)\b/g;

/** Friendly and plural names the prose uses, mapped onto registry entry ids. */
const TOKEN_TO_ENTRY_ID: Readonly<Record<string, string>> = {
	PDF: "pdf",
	PDFS: "pdf",
	DOCX: "docx",
	XLSX: "xlsx",
	XLS: "xls",
	PPTX: "pptx",
	CSV: "csv",
	TSV: "tsv",
	ZIP: "zip",
	JSON: "json",
	HTML: "html",
	MARKDOWN: "md",
	MD: "md",
	TXT: "txt",
	EXCEL: "xlsx",
	POWERPOINT: "pptx",
};

function formatIds(prose: string): Set<string> {
	const ids = new Set<string>();
	for (const match of prose.matchAll(FORMAT_TOKEN)) {
		const token = (match[1] ?? match[2]).toUpperCase();
		const id = TOKEN_TO_ENTRY_ID[token];
		expect(
			id,
			`no registry id is mapped for the prose token "${token}"`,
		).toBeDefined();
		ids.add(id);
	}
	return ids;
}

function entryById(id: string) {
	return FILE_TYPE_ENTRIES.find((entry) => entry.id === id) ?? null;
}

/** The chart types a `documentSource` chart block may declare. */
function supportedChartTypes(): string[] {
	const union = SOURCE_SCHEMA.match(
		/export type GeneratedDocumentChartType =([^;]+);/,
	);
	expect(union, "GeneratedDocumentChartType union not found").not.toBeNull();
	return [...(union?.[1] ?? "").matchAll(/"([a-zA-Z]+)"/g)].map(
		(match) => match[1],
	);
}

/** The chart types a produce_file description offers the model. */
function advertisedChartTypes(description: string): string[] {
	const listed = description.match(/chartType:([a-zA-Z|]+)/);
	expect(listed, "no chartType list in the description").not.toBeNull();
	return (listed?.[1] ?? "").split("|");
}

// ───────────────────────────────────────────────────────────────────────────

describe("cached prompt prefix stays byte-identical", () => {
	// A failure here is not a test to update: it means a prompt-prefix cache
	// eviction for every user is about to ship. Confirm that is intended, then
	// re-freeze deliberately.
	it("keeps the prompts.ts produce_file row unchanged", () => {
		expect(PROMPTS).toContain(FROZEN_PROMPTS_PRODUCE_FILE_ROW);
		for (const line of FROZEN_PROMPTS_PRODUCE_FILE_GUIDANCE) {
			expect(PROMPTS).toContain(line);
		}
	});

	it("keeps both produce_file tool descriptions unchanged", () => {
		expect(toolDescriptions("produce_file")).toEqual([
			FROZEN_EN_PRODUCE_FILE,
			FROZEN_HU_PRODUCE_FILE,
		]);
	});

	it("keeps both read_generated_file tool descriptions unchanged", () => {
		expect(toolDescriptions("read_generated_file")).toEqual([
			FROZEN_EN_READ_GENERATED_FILE,
			FROZEN_HU_READ_GENERATED_FILE,
		]);
	});
});

describe("model-facing prose names only real formats", () => {
	it("accepts every type the model-facing examples name", () => {
		// Moved from output-types.test.ts:21-28 and kept.
		for (const example of FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES.split(", ")) {
			expect(isSupportedFileProductionOutputType(example), example).toBe(true);
		}
	});

	it("only promises formats produce_file can actually make", () => {
		const sources: Record<string, string> = {
			"prompts.ts": PROMPTS,
			"produce_file (en)": FROZEN_EN_PRODUCE_FILE,
			"produce_file (hu)": FROZEN_HU_PRODUCE_FILE,
		};
		for (const [label, prose] of Object.entries(sources)) {
			const ids = formatIds(prose);
			expect(ids.size, label).toBeGreaterThan(4);
			for (const id of ids) {
				const entry = entryById(id);
				expect(entry, `${label} names "${id}"`).not.toBeNull();
				expect(
					entry?.production.requestable,
					`${label} names "${id}", which produce_file cannot produce`,
				).toBe(true);
			}
		}
	});

	it("names the same formats in English and Hungarian", () => {
		// Nothing checked this before: the HU description is a hand translation
		// of a 1,400-character string, and a dropped format would silently make
		// Hungarian users' model less capable.
		expect([...formatIds(FROZEN_HU_PRODUCE_FILE)].sort()).toEqual(
			[...formatIds(FROZEN_EN_PRODUCE_FILE)].sort(),
		);
		expect([...formatIds(FROZEN_HU_READ_GENERATED_FILE)].sort()).toEqual(
			[...formatIds(FROZEN_EN_READ_GENERATED_FILE)].sort(),
		);
	});

	it("lets only `zip` be producible but not ingestible", () => {
		// Spec conflict 10 / open question 4: Phase >= 2 moves it to the
		// RESERVED "archive" intake route.
		const PRODUCTION_ONLY_TYPES = new Set(["zip"]);
		for (const entry of FILE_TYPE_ENTRIES) {
			if (!entry.production.requestable) continue;
			if (PRODUCTION_ONLY_TYPES.has(entry.id)) continue;
			expect(entry.intake.route, entry.id).not.toBe("reject");
		}
	});
});

describe("built-in skill prose names only real formats", () => {
	// Spec row 62: the prose stays hand-written, exactly like the tool
	// descriptions; only this verification is new.
	const sources: Record<string, string> = {
		"user-skills.ts": USER_SKILLS,
		"skill-eval-fixtures.ts": SKILL_FIXTURES,
	};

	it("names only types the registry knows", () => {
		for (const [label, prose] of Object.entries(sources)) {
			const ids = formatIds(prose);
			expect(ids.size, label).toBeGreaterThan(2);
			for (const id of ids) {
				expect(entryById(id), `${label} names "${id}"`).not.toBeNull();
			}
		}
	});

	it("names exactly one format produce_file cannot produce", () => {
		const ids = [...formatIds(USER_SKILLS)].filter(
			(id) => entryById(id)?.production.requestable === false,
		);
		expect(new Set(ids)).toEqual(
			KNOWN_PROSE_EXCEPTIONS.nonRequestableSkillFormats,
		);
		// `.tsv` was the other one: it had an entry only so this prose
		// resolved, and slice P5-A made it a real direct-text upload and a
		// requestable output. The prose that already said "XLSX/CSV/TSV"
		// became true without being touched, which is why these two
		// assertions replaced the exception rather than a re-freeze.
		expect(entryById("tsv")?.intake.route).toBe("direct-text");
		expect(entryById("tsv")?.production.requestable).toBe(true);
	});

	it("keeps the eval fixture byte-identical to the shipped skill prose", () => {
		// Spec row 63: `scripts/skill-eval-fixtures.ts` duplicates the
		// spreadsheet-builder instructions. A fixture that drifts from the
		// prose it is meant to measure silently invalidates the eval.
		//
		// The duplication stays duplication on purpose. These three lines are
		// the `previousBuiltInSystemSkillDefaults` MIGRATION BASELINE, which
		// every user's stored copy is diffed against, so neither side may
		// change; and importing them would pull `user-skills.ts` — and with it
		// `$lib/server/db` — into a script whose whole job is to measure prose
		// offline. The byte-identity below is the cheaper guarantee.
		const instructionLines = [
			"Use this skill when the user asks to create, edit, analyze, visualize, or work with spreadsheet files such as .xlsx, .xls, .csv, or .tsv.",
			'For downloadable XLSX creation, route the work through produce_file with structured tool input: sourceMode: "program", requestedOutputs: [{ "type": "xlsx" }], program: { language: "javascript", sourceCode, filename }, idempotencyKey, requestTitle, and documentIntent.',
			'The JavaScript program.sourceCode should use exceljs and write final requested files under /output with workbook.xlsx.writeFile("/output/<name>.xlsx"). When program.filename is provided, produce exactly one final requested workbook at /output/<name>.xlsx and do not write scratch diagnostics or unrelated files under /output.',
		];
		for (const line of instructionLines) {
			expect(USER_SKILLS, line.slice(0, 48)).toContain(line);
			expect(SKILL_FIXTURES, line.slice(0, 48)).toContain(line);
		}
	});
});

describe("documentSource chart types the tool prose offers", () => {
	it("offers the same chart types in English and Hungarian", () => {
		expect(advertisedChartTypes(FROZEN_HU_PRODUCE_FILE)).toEqual(
			advertisedChartTypes(FROZEN_EN_PRODUCE_FILE),
		);
	});

	it("offers exactly the chart types documentSource accepts", () => {
		// Bidirectional since slice P6-D: the prose used to name five of the
		// seven, which left `area` and `stackedBar` reachable only by guessing.
		// Now every supported type is offered and every offered type is
		// supported, so neither list can move without the other.
		const supported = supportedChartTypes();
		expect(supported.length).toBeGreaterThan(4);
		expect(advertisedChartTypes(FROZEN_EN_PRODUCE_FILE)).toEqual(supported);
	});

	it("tells the model that stackedBar needs a seriesKey", () => {
		// `source-schema.ts` refuses a stacked bar without one, so advertising
		// the type without the field would offer a chart that always fails.
		expect(SOURCE_SCHEMA).toContain('chartType === "stackedBar"');
		for (const prose of [FROZEN_EN_PRODUCE_FILE, FROZEN_HU_PRODUCE_FILE]) {
			expect(prose).toContain("seriesKey(stackedBar only)");
		}
	});
});
