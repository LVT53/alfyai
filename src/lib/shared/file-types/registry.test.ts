// Structural invariants of the file-type table (spec section 6.1).
//
// These are the rules a future entry has to satisfy. They are deliberately
// about SHAPE, not about behaviour — behaviour preservation lives in
// `legacy-equivalence.test.ts`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	admitUpload,
	FILE_TYPE_ENTRIES,
	fileExtension,
	getAcceptAttribute,
	getAcceptedExtensions,
	getEntryByExtension,
	getEntryByMimeType,
	getIntakeRoute,
	KNOWLEDGE_ACCEPT_OMISSIONS,
	SURFACE_ACCEPT_ORDER,
} from "./index";
import {
	getProducibleFormatList,
	getSupportedExtractionSummary,
} from "./model-facing";
import {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	getExpectedExtensionForOutputType,
	isSupportedFileProductionOutputType,
} from "./production";

const here = path.dirname(fileURLToPath(import.meta.url));

const ALL_EXTENSIONS = FILE_TYPE_ENTRIES.flatMap((entry) => [
	...entry.extensions,
]);

/**
 * Highlighter language ids. A new entry may not invent one — the preview
 * runtime has to know how to load it.
 */
const PREVIEW_LANGUAGES = new Set([
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"go",
	"graphql",
	"html",
	"ini",
	"java",
	"javascript",
	"json",
	"jsx",
	"kotlin",
	"less",
	"markdown",
	"php",
	"python",
	"r",
	"ruby",
	"rust",
	"sass",
	"scss",
	"sql",
	"swift",
	"toml",
	"tsx",
	"typescript",
	"xml",
	"yaml",
]);

describe("file-type registry invariants", () => {
	it("has the expected size", () => {
		// A tripwire, not a target: changing it is fine, doing so by accident is
		// not. (The spec's section 2.1 footer says 80/92; counting its own tables
		// gives 70/88, plus the `tsv` entry from open question 12.)
		expect(FILE_TYPE_ENTRIES.length).toBe(71);
		expect(ALL_EXTENSIONS.length).toBe(89);
	});

	it("gives every entry a unique id equal to its canonical extension", () => {
		const ids = FILE_TYPE_ENTRIES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(entry.id).toBe(entry.extensions[0]);
		}
	});

	it("claims every extension exactly once", () => {
		const seen = new Map<string, string>();
		for (const entry of FILE_TYPE_ENTRIES) {
			for (const extension of entry.extensions) {
				expect(
					seen.get(extension),
					`"${extension}" is claimed by both "${seen.get(extension)}" and "${entry.id}"`,
				).toBeUndefined();
				seen.set(extension, entry.id);
			}
		}
		expect(seen.size).toBe(ALL_EXTENSIONS.length);
	});

	it("keeps extensions lowercase, undotted and dot-free", () => {
		for (const extension of ALL_EXTENSIONS) {
			expect(extension).toBe(extension.toLowerCase());
			expect(extension.startsWith(".")).toBe(false);
			expect(extension).not.toContain(".");
			expect(extension.trim()).toBe(extension);
			expect(extension.length).toBeGreaterThan(0);
		}
	});

	it("keeps MIME types non-empty, lowercase and type/subtype shaped", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(entry.mimeTypes.length).toBeGreaterThan(0);
			for (const mimeType of entry.mimeTypes) {
				expect(mimeType).toBe(mimeType.toLowerCase());
				expect(mimeType).toMatch(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/);
			}
			expect(new Set(entry.mimeTypes).size).toBe(entry.mimeTypes.length);
		}
	});

	it("names exactly one owner for every contested canonical MIME", () => {
		const claimants = new Map<string, string[]>();
		for (const entry of FILE_TYPE_ENTRIES) {
			const canonical = entry.mimeTypes[0];
			claimants.set(canonical, [...(claimants.get(canonical) ?? []), entry.id]);
		}

		const contested = [...claimants].filter(([, ids]) => ids.length > 1);
		// Only "text/plain" is contested today, by txt / ini / log.
		expect(contested.map(([mime]) => mime)).toEqual(["text/plain"]);

		for (const [mime, ids] of contested) {
			const owners = ids.filter(
				(id) =>
					FILE_TYPE_ENTRIES.find((entry) => entry.id === id)?.ownsCanonicalMime,
			);
			expect(owners, `${mime} needs exactly one owner`).toHaveLength(1);
			expect(getEntryByMimeType(mime)?.id).toBe(owners[0]);
		}
	});

	it("never sets ownsCanonicalMime on an uncontested MIME", () => {
		// The flag only exists to break a tie; a stray one hides a real conflict.
		const canonicalCounts = new Map<string, number>();
		for (const entry of FILE_TYPE_ENTRIES) {
			const canonical = entry.mimeTypes[0];
			canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1);
		}
		for (const entry of FILE_TYPE_ENTRIES) {
			if (!entry.ownsCanonicalMime) continue;
			expect(canonicalCounts.get(entry.mimeTypes[0])).toBeGreaterThan(1);
		}
	});

	it("pairs a reject route with a reject reason, and only then", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(
				entry.intake.rejectReason !== undefined,
				`${entry.id} route=${entry.intake.route} reason=${entry.intake.rejectReason}`,
			).toBe(entry.intake.route === "reject");
		}
	});

	it("uses no RESERVED intake route", () => {
		const reserved = FILE_TYPE_ENTRIES.filter(
			(entry) =>
				entry.intake.route === "vision" || entry.intake.route === "archive",
		);
		expect(reserved.map((entry) => entry.id)).toEqual([]);
	});

	it("keeps production.types empty exactly when the type is not requestable", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			const tokens = Object.keys(entry.production.types);
			if (!entry.production.requestable) {
				expect(tokens, `${entry.id}`).toEqual([]);
				continue;
			}
			expect(tokens.length, `${entry.id}`).toBeGreaterThan(0);
			for (const [token, extension] of Object.entries(entry.production.types)) {
				expect(extension.startsWith("."), `${entry.id}.${token}`).toBe(true);
				expect(token).toBe(token.trim().toLowerCase());
			}
		}
	});

	it("only produces extensions the table knows", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			for (const extension of Object.values(entry.production.types)) {
				expect(
					getEntryByExtension(extension),
					`${entry.id} produces ${extension}, which no entry claims`,
				).not.toBeNull();
			}
		}
	});

	it("keeps documentSource strictly narrower than documentRenderKind", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			if (!entry.production.documentSource) continue;
			expect(
				entry.production.documentRenderKind,
				`${entry.id} is a document source with no render kind`,
			).toBeDefined();
		}
		// `md` is the case that makes the two fields necessary.
		const md = FILE_TYPE_ENTRIES.find((entry) => entry.id === "md");
		expect(md?.production.documentRenderKind).toBe("markdown");
		expect(md?.production.documentSource).toBeUndefined();
	});

	it("draws preview languages from the known set", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			const language = entry.preview.language;
			if (language === undefined) continue;
			expect(
				PREVIEW_LANGUAGES.has(language),
				`${entry.id} -> ${language}`,
			).toBe(true);
		}
	});

	it("ties textLike to the `text` production validation class", () => {
		// FULL_VALIDATION = {textLike} union {validation === "xlsx"} only holds if
		// these two never drift (spec conflict 4).
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(entry.production.validation === "text", `${entry.id}`).toBe(
				entry.textLike,
			);
		}
	});

	it("keeps SURFACE_ACCEPT_ORDER.knowledge in step with the knowledge entries", () => {
		const fromEntries = new Set(
			FILE_TYPE_ENTRIES.filter((entry) =>
				entry.surfaces.includes("knowledge"),
			).flatMap((entry) => [...entry.extensions]),
		);
		const fromOrder = SURFACE_ACCEPT_ORDER.knowledge ?? [];

		expect(new Set(fromOrder).size, "duplicate in the accept order").toBe(
			fromOrder.length,
		);
		for (const extension of fromOrder) {
			expect(
				fromEntries.has(extension),
				`${extension} is not a knowledge entry`,
			).toBe(true);
		}
		// `.markdown` is the single documented gap (spec open question 3). Any
		// OTHER knowledge extension missing from the order is a drift bug.
		const missing = [...fromEntries].filter(
			(extension) => !fromOrder.includes(extension),
		);
		expect(missing.sort()).toEqual([...KNOWLEDGE_ACCEPT_OMISSIONS].sort());
	});

	it("builds accept attributes from the surface lists", () => {
		expect(getAcceptAttribute("knowledge")).toBe(
			getAcceptedExtensions("knowledge")
				.map((extension) => `.${extension}`)
				.join(","),
		);
		// Chat lists every chat entry, in table order.
		expect(getAcceptedExtensions("chat")).toEqual(
			FILE_TYPE_ENTRIES.filter((entry) =>
				entry.surfaces.includes("chat"),
			).flatMap((entry) => [...entry.extensions]),
		);
		// Memoisation must hand back the same value, not rebuild it.
		expect(getAcceptAttribute("chat")).toBe(getAcceptAttribute("chat"));
	});

	it("parses extensions the way attachment-file-type.ts does", () => {
		// Spec open question 13 asks for parity with `attachment-file-type.ts:76`.
		// It also claims that means `.env` -> ""; it does not. `".env".split(".")`
		// has length 2, so the guard does not fire and the answer is "env".
		// `extname(".env")` is the one that returns "". Parity with the named
		// function is what the registry implements.
		expect(fileExtension(".env")).toBe("env");
		expect(fileExtension("REPORT.Final.PDF")).toBe("pdf");
		expect(fileExtension("noext")).toBe("");
		expect(fileExtension("")).toBe("");
		expect(fileExtension("archive.tar.gz")).toBe("gz");
	});

	it("keeps the table free of value imports", () => {
		const source = readFileSync(path.join(here, "table.ts"), "utf8");
		expect(source.match(/^import\s+(?!type\b)/gm)).toBeNull();
		expect(source).not.toContain("jszip");
	});

	it("keeps production and model-facing off the client entry point", () => {
		const source = readFileSync(path.join(here, "index.ts"), "utf8");
		expect(source).not.toContain('from "./production"');
		expect(source).not.toContain('from "./model-facing"');
	});

	it("derives the model-facing examples from exampleRank", () => {
		expect(FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES).toBe(
			"xlsx, docx, pptx, pdf, csv, zip",
		);
		for (const example of FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES.split(", ")) {
			expect(isSupportedFileProductionOutputType(example)).toBe(true);
		}
	});

	it("gives every exampleRank a distinct position among requestable types", () => {
		const ranked = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.production.exampleRank !== undefined,
		);
		const ranks = ranked.map((entry) => entry.production.exampleRank);
		expect(new Set(ranks).size).toBe(ranks.length);
		for (const entry of ranked) {
			expect(entry.production.requestable, `${entry.id}`).toBe(true);
		}
	});

	it("lets only `zip` be producible but not ingestible", () => {
		// Spec conflict 10 / open question 4: Phase >= 2 moves it to the RESERVED
		// "archive" route.
		const productionOnly = FILE_TYPE_ENTRIES.filter(
			(entry) =>
				entry.production.requestable && entry.intake.route === "reject",
		).map((entry) => entry.id);
		expect(productionOnly).toEqual(["zip"]);
	});

	it("only advertises extraction formats the upload endpoint admits", () => {
		// The ids `model-facing.getSupportedExtractionSummary` names.
		for (const id of ["txt", "html", "json", "pdf", "docx", "pptx", "xlsx"]) {
			const entry = FILE_TYPE_ENTRIES.find((candidate) => candidate.id === id);
			expect(entry, `${id} is named in the extraction summary`).toBeDefined();
			expect(entry?.intake.route).not.toBe("reject");
		}
		expect(getSupportedExtractionSummary("en")).toContain(
			"PDF, DOCX, PPTX, XLSX",
		);
		expect(getSupportedExtractionSummary("hu")).toContain(
			"PDF, DOCX, PPTX, XLSX",
		);
	});

	it("lists every requestable type in the producible format list", () => {
		const listed = getProducibleFormatList("en").split(", ");
		const requestable = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.production.requestable,
		).map((entry) => entry.id.toUpperCase());
		expect([...listed].sort()).toEqual([...requestable].sort());
		// Ranked: the examples come first, in rank order.
		expect(listed.slice(0, 6)).toEqual([
			"XLSX",
			"DOCX",
			"PPTX",
			"PDF",
			"CSV",
			"ZIP",
		]);
		expect(getProducibleFormatList("hu")).toBe(getProducibleFormatList("en"));
	});

	it("routes unknown types to mineru and known reject entries to reject", () => {
		expect(getIntakeRoute("mystery.qqq", null)).toBe("mineru");
		expect(getIntakeRoute("clip.mp4", "video/mp4")).toBe("reject");
		expect(getIntakeRoute("notes.txt", null)).toBe("direct-text");
		expect(getIntakeRoute("scan.pdf", null)).toBe("mineru");
	});

	// `dev`'s `isDirectTextExtractionFile` read ANY file whose declared MIME
	// started with "text/" (plus four application types) directly, whatever its
	// extension. The table cannot enumerate every text extension in the world,
	// so the MIME keeps that door open: without it `.diff`, `.patch`, `.rst`,
	// `.tex`, `.srt`, `.vtt` and `.properties` uploads that worked on `dev`
	// would be refused as `unknownType`.
	describe("the unknown-extension text/* fallback", () => {
		const TEXT_MIME_CASES = [
			["notes.diff", "text/plain"],
			["fix.patch", "text/x-diff"],
			["readme.rst", "text/x-rst"],
			["paper.tex", "text/x-tex"],
			["subs.srt", "text/plain"],
			["subs.vtt", "text/vtt"],
			["app.properties", "text/plain"],
			["schema.avsc", "application/json"],
			["feed.rdf", "application/xml"],
			["chart.tpl", "application/yaml"],
			["module.mts", "application/typescript"],
			// A MIME with parameters still counts.
			["notes.diff", "text/plain; charset=utf-8"],
			// Nameless uploads resolve on the MIME alone.
			["", "text/plain"],
		] as const;

		it.each(TEXT_MIME_CASES)(
			"admits %s declared as %s and reads it directly",
			(fileName, mimeType) => {
				expect(admitUpload(fileName, mimeType)).toMatchObject({
					allowed: true,
				});
				expect(getIntakeRoute(fileName, mimeType)).toBe("direct-text");
			},
		);

		it("still refuses an unknown extension with a generic or absent MIME", () => {
			for (const mimeType of [
				null,
				"",
				"application/octet-stream",
				"application/download",
			]) {
				expect(
					admitUpload("mystery.qqq", mimeType),
					`${mimeType}`,
				).toMatchObject({ allowed: false, reason: "unknownType" });
				expect(getIntakeRoute("mystery.qqq", mimeType)).toBe("mineru");
			}
		});

		it("never lets a text/* MIME talk a reject entry past the gate", () => {
			// The extension still wins: claiming text/plain for a .mp4 or a .zip
			// must not reopen exception (b)/(c).
			for (const fileName of ["clip.mp4", "bundle.zip", "memo.rtf"]) {
				expect(admitUpload(fileName, "text/plain"), fileName).toMatchObject({
					allowed: false,
				});
			}
		});
	});

	it("lets only a document header wander from its offset", () => {
		// `searchWithinBytes` exists for PDF, whose spec tells readers to look
		// for `%PDF-` within the first 1024 bytes. A container format must not
		// get the same licence: a ZIP or a PNG whose magic is one byte late is
		// a real mismatch, and a wide window would weaken the content check
		// into "does this byte sequence appear anywhere near the start".
		const searching = FILE_TYPE_ENTRIES.filter((entry) =>
			entry.signatures?.some(
				(signature) => signature.searchWithinBytes !== undefined,
			),
		).map((entry) => entry.id);
		expect(searching).toEqual(["pdf"]);

		for (const entry of FILE_TYPE_ENTRIES) {
			for (const signature of entry.signatures ?? []) {
				expect(signature.offset, entry.id).toBeGreaterThanOrEqual(0);
				expect(signature.bytes.length, entry.id).toBeGreaterThan(0);
				expect(signature.searchWithinBytes ?? 0, entry.id).toBeLessThanOrEqual(
					1024,
				);
			}
		}
	});

	it("never reverse-resolves a generic MIME to an entry", () => {
		// `application/octet-stream` is an accepted alias of `zip`; resolving it
		// backwards would refuse every unknown upload as an archive.
		expect(getEntryByMimeType("application/octet-stream")).toBeNull();
		expect(getEntryByMimeType("application/download")).toBeNull();
		expect(getEntryByMimeType("")).toBeNull();
		expect(getEntryByMimeType(null)).toBeNull();
	});

	it("round-trips every production token to a known extension", () => {
		for (const entry of FILE_TYPE_ENTRIES) {
			for (const [token, extension] of Object.entries(entry.production.types)) {
				expect(getExpectedExtensionForOutputType(token)).toBe(extension);
				expect(
					getExpectedExtensionForOutputType(` ${token.toUpperCase()} `),
				).toBe(extension);
			}
		}
	});
});
