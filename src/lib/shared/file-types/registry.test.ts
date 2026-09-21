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
	buildAcceptAttribute,
	FILE_TYPE_ENTRIES,
	fileExtension,
	getAcceptAttribute,
	getAcceptedExtensions,
	getEntryByExtension,
	getEntryByMimeType,
	getIntakeFallbackRoute,
	getIntakeRoute,
	getMineru4FallbackFileTypeIds,
	getMineru4GatedFileTypeIds,
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
	isInlineTextOutputType,
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
		// not. Phase 1 landed 71 entries / 89 extensions; Phase 5 adds `epub`
		// and `ofd` and no other entry, so 73 / 91.
		expect(FILE_TYPE_ENTRIES.length).toBe(73);
		expect(ALL_EXTENSIONS.length).toBe(91);
	});

	it("keeps the reject/non-reject split where Phase 5 left it", () => {
		// The other half of the tripwire, and the one the accept strings are
		// built from: `rtf`, `ods`, `odp` and `tsv` became ingestible, `ofd`
		// arrived as the only new refusal. The phase5-6 follow-up then moved
		// `avif` from `mineru` to `reject` (MinerU 4.0.4 permanently refuses it),
		// so the reject count is 18, not 17, from here on.
		const rejectExtensions = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.intake.route === "reject",
		).flatMap((entry) => [...entry.extensions]);
		expect(rejectExtensions.length).toBe(18);
		expect(ALL_EXTENSIONS.length - rejectExtensions.length).toBe(73);

		const requestable = FILE_TYPE_ENTRIES.filter(
			(entry) => entry.production.requestable,
		);
		expect(requestable.length).toBe(41);

		// `formatNotEnabled` has exactly one user left in the table; every other
		// use of it is a runtime decision by the MinerU-4 gate.
		expect(
			FILE_TYPE_ENTRIES.filter(
				(entry) => entry.intake.rejectReason === "formatNotEnabled",
			).map((entry) => entry.id),
		).toEqual(["ofd"]);

		// `convertImage` — the phase5-6 follow-up reason for a format that is an
		// image, not a document, so `formatNotEnabled`'s "Save it as PDF or
		// DOCX" copy would be wrong advice. `avif` is its only user.
		expect(
			FILE_TYPE_ENTRIES.filter(
				(entry) => entry.intake.rejectReason === "convertImage",
			).map((entry) => entry.id),
		).toEqual(["avif"]);
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
		// Phase 5 D5 closed the one documented gap (`.markdown`), so
		// KNOWLEDGE_ACCEPT_OMISSIONS is empty and NOTHING may be missing. A new
		// knowledge entry still has to be added to SURFACE_ACCEPT_ORDER by hand.
		const missing = [...fromEntries].filter(
			(extension) => !fromOrder.includes(extension),
		);
		expect(missing.sort()).toEqual([...KNOWLEDGE_ACCEPT_OMISSIONS].sort());
		expect([...KNOWLEDGE_ACCEPT_OMISSIONS]).toEqual([]);
	});

	it("offers the same set of extensions on both surfaces", () => {
		// Phase 5 D5 / OQ4. The server gate is surface-independent, so a
		// narrower knowledge list only hid types the server already accepted.
		// The two lists now differ only in ORDER.
		const knowledge = new Set(getAcceptedExtensions("knowledge"));
		const chat = new Set(getAcceptedExtensions("chat"));
		expect(knowledge).toEqual(chat);

		const nonReject = new Set(
			FILE_TYPE_ENTRIES.filter(
				(entry) => entry.intake.route !== "reject",
			).flatMap((entry) => [...entry.extensions]),
		);
		expect(knowledge).toEqual(nonReject);
		// 74 through the phase5-6 P5-A merge; `avif` moving to `reject` in the
		// follow-up (MinerU 4.0.4 permanently refuses it) drops this to 73.
		expect(knowledge.size).toBe(73);

		// The converse: a reject entry is offered nowhere.
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(entry.surfaces, entry.id).toEqual(
				entry.intake.route === "reject" ? [] : ["knowledge", "chat"],
			);
		}
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
		// Phase 5 D11 keeps the by-name exemption. The `archive` intake route is
		// described in phase5-6-uploads-generation-spec.md section 3.4 and
		// deliberately NOT built, so `zip` stays `reject`/`archive`: flipping the
		// route would make `admitUpload` answer `allowed: true` for a `.zip`
		// with no extractor behind it.
		const productionOnly = FILE_TYPE_ENTRIES.filter(
			(entry) =>
				entry.production.requestable && entry.intake.route === "reject",
		).map((entry) => entry.id);
		expect(productionOnly).toEqual(["zip"]);
	});

	it("names the inline_text output types exactly", () => {
		// Phase 6 D8: the outputs that are bytes we already hold, i.e. the set
		// `buildTextFileProgram` was spawning a container for. `html` is
		// text-validated but is a document source, so it belongs to the report
		// renderers; `svg`, `xlsx`, `pptx` and `zip` are not text-validated.
		const inlineIds = FILE_TYPE_ENTRIES.filter(
			(entry) =>
				entry.production.requestable &&
				Object.keys(entry.production.types).some((token) =>
					isInlineTextOutputType(token),
				),
		).map((entry) => entry.id);
		expect(inlineIds).toContain("md");
		expect(inlineIds).toContain("tsv");
		expect(inlineIds).toContain("csv");
		expect(inlineIds).not.toContain("html");

		for (const token of ["md", "markdown", "tsv", "csv", "txt", "json"]) {
			expect(isInlineTextOutputType(token), token).toBe(true);
		}
		for (const token of ["html", "pdf", "docx", "xlsx", "pptx", "zip", "svg"]) {
			expect(isInlineTextOutputType(token), token).toBe(false);
		}
		// An unknown token is never inline, and a mixed request is decided by
		// the caller's `every`.
		expect(isInlineTextOutputType("qqq")).toBe(false);
	});

	it("only advertises extraction formats the upload endpoint admits", () => {
		// The ids `model-facing.getSupportedExtractionSummary` names. One id per
		// family: `docx` stands for `doc` too, `odt` for `ods`/`odp`.
		for (const id of [
			"txt",
			"html",
			"json",
			"pdf",
			"docx",
			"xlsx",
			"pptx",
			"odt",
			"epub",
			"rtf",
		]) {
			const entry = FILE_TYPE_ENTRIES.find((candidate) => candidate.id === id);
			expect(entry, `${id} is named in the extraction summary`).toBeDefined();
			expect(entry?.intake.route).not.toBe("reject");
		}
		expect(getSupportedExtractionSummary("en")).toContain(
			"PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF",
		);
		expect(getSupportedExtractionSummary("hu")).toContain(
			"PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF",
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
		// Phase 5: the three routes that moved.
		expect(getIntakeRoute("page.html", null)).toBe("mineru");
		expect(getIntakeRoute("data.tsv", null)).toBe("direct-text");
		expect(getIntakeRoute("doc.ofd", null)).toBe("reject");
	});

	it("routes HTML with an odd extension through the entry, not the MIME", () => {
		// `resolveEntry` misses on the extension, hits `text/html` -> the `html`
		// entry -> mineru. `isDirectTextFallbackMimeType` would have said
		// "direct-text" before Phase 5; the entry wins because `getIntakeRoute`
		// consults `resolveEntry` first.
		expect(getIntakeRoute("page.download", "text/html")).toBe("mineru");
		// And the extension still beats a contradicting MIME.
		expect(getIntakeRoute("page.html", "text/plain")).toBe("mineru");
		expect(getIntakeRoute("page.htm", null)).toBe("mineru");
	});

	it("gates only the formats a 3.x backend cannot parse", () => {
		// D6 + the amended OQ2. Gated = hidden and refused on a positively
		// pre-4 backend. `html` is NOT here: it carries `requiresMineru4` too,
		// but with a `fallbackRoute`, so it degrades instead of disappearing.
		expect(getMineru4GatedFileTypeIds()).toEqual([
			"epub",
			"odp",
			"ods",
			"odt",
			"rtf",
		]);
		expect(getMineru4FallbackFileTypeIds()).toEqual(["html"]);

		for (const id of [
			...getMineru4GatedFileTypeIds(),
			...getMineru4FallbackFileTypeIds(),
		]) {
			const entry = FILE_TYPE_ENTRIES.find((candidate) => candidate.id === id);
			// Only a MinerU-routed entry can be gated: a direct-text or reject
			// entry does not talk to the backend at all, so the flag would be a
			// lie there.
			expect(entry?.intake.route, id).toBe("mineru");
		}

		for (const entry of FILE_TYPE_ENTRIES) {
			if (entry.intake.requiresMineru4) {
				expect(entry.intake.route, entry.id).toBe("mineru");
				continue;
			}
			// A fallback without the flag is unreachable — nothing would ever
			// consult it.
			expect(entry.intake.fallbackRoute, entry.id).toBeUndefined();
		}

		// A fallback is a DOWNGRADE, never a refusal: a refusal is expressed by
		// leaving `fallbackRoute` absent and letting the gate hide the entry.
		expect(getIntakeFallbackRoute("page.html", null)).toBe("direct-text");
		expect(getIntakeFallbackRoute("page.htm", null)).toBe("direct-text");
		expect(getIntakeFallbackRoute("book.epub", null)).toBeNull();
		expect(getIntakeFallbackRoute("notes.txt", null)).toBeNull();
		for (const entry of FILE_TYPE_ENTRIES) {
			expect(entry.intake.fallbackRoute, entry.id).not.toBe("reject");
		}
	});

	it("gives every mineru Office entry a flash tier hint", () => {
		// D4 / OQ11. PDF and the images stay unhinted: they are the only inputs
		// the fixtures show resolving to `basic`.
		for (const id of [
			"docx",
			"xlsx",
			"pptx",
			"odt",
			"ods",
			"odp",
			"doc",
			"xls",
			"ppt",
			"rtf",
			"epub",
			"html",
		]) {
			const entry = FILE_TYPE_ENTRIES.find((candidate) => candidate.id === id);
			expect(entry?.intake.tierHint, id).toBe("flash");
		}
		for (const id of [
			"pdf",
			"jpg",
			"png",
			"gif",
			"webp",
			"bmp",
			"tif",
			"heic",
			"heif",
			"avif",
		]) {
			const entry = FILE_TYPE_ENTRIES.find((candidate) => candidate.id === id);
			expect(entry?.intake.tierHint, id).toBeUndefined();
		}
		// A tier hint on a route that never reaches MinerU is meaningless.
		for (const entry of FILE_TYPE_ENTRIES) {
			if (entry.intake.tierHint === undefined) continue;
			expect(entry.intake.route, entry.id).toBe("mineru");
		}
	});

	it("`buildAcceptAttribute` drops exactly the disabled entries", () => {
		const disabled = new Set(getMineru4GatedFileTypeIds());
		for (const surface of ["knowledge", "chat"] as const) {
			const full = getAcceptAttribute(surface).split(",");
			const gated = buildAcceptAttribute(surface, disabled).split(",");
			expect(
				full.filter((extension) => !gated.includes(extension)).sort(),
			).toEqual([".epub", ".odp", ".ods", ".odt", ".rtf"]);
			// Order of what survives is untouched.
			expect(gated).toEqual(
				full.filter(
					(extension) =>
						![".epub", ".odp", ".ods", ".odt", ".rtf"].includes(extension),
				),
			);
			// `.html`/`.htm` keep their place — they fall back, they do not hide.
			expect(gated).toContain(".html");
			expect(gated).toContain(".htm");
		}
		// The empty and absent cases are the memoised fast path.
		expect(buildAcceptAttribute("knowledge")).toBe(
			getAcceptAttribute("knowledge"),
		);
		expect(buildAcceptAttribute("chat", new Set())).toBe(
			getAcceptAttribute("chat"),
		);
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

		it.each(
			TEXT_MIME_CASES,
		)("admits %s declared as %s and reads it directly", (fileName, mimeType) => {
			expect(admitUpload(fileName, mimeType)).toMatchObject({
				allowed: true,
			});
			expect(getIntakeRoute(fileName, mimeType)).toBe("direct-text");
		});

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
			// must not reopen exception (b)/(c). `memo.rtf` used to be the third
			// case; Phase 5 made `.rtf` ingestible, so `.ofd` — the one entry
			// still refused as `formatNotEnabled` — takes its place.
			for (const fileName of ["clip.mp4", "bundle.zip", "scan.ofd"]) {
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
