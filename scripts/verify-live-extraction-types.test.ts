import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMineruResultZip } from "../src/lib/server/services/mineru/result";
import {
	CASES,
	compare,
	FAILURE_CASES,
	failureMismatches,
	isDirectRun,
	preflightProblems,
	readActual,
} from "./verify-live-extraction-types";

// The sweep itself needs a deployment and credentials, so these tests hold what
// it DECIDES: whether a row matches its expectation, whether the deployment is
// the one the run was written for, and whether a failing document failed the
// right way. Plus the one thing that can be proven offline: the expectations of
// the rows built from the 4.1.7 spike's own files against what the app's real
// parser makes of the captured answers.

const EXPECTED = {
	pdfTier: "standard",
	serverVersion: "4.1.7",
	parserVersion: "mineru4/2",
};

function caseById(id: string) {
	const found = CASES.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no case ${id}`);
	return found;
}

/** A run of `id` that matches every expectation of the case, to break one at a time. */
function faithfulRun(id: string) {
	const testCase = caseById(id);
	const tier =
		testCase.expect.effectiveTier === "expected-pdf-tier"
			? EXPECTED.pdfTier
			: testCase.expect.effectiveTier;
	return {
		testCase,
		actual: {
			effectiveTier: tier,
			jobTier: tier,
			pageCount: testCase.expect.pageCount,
			pageCountKind: testCase.expect.pageCountKind,
			textLength: testCase.expect.minTextLength,
			figureCount: testCase.expect.figureCount,
			outlineLength: testCase.expect.outlineMin,
			outlinePages: testCase.expect.outlineMin,
			unknownBlockTypes: {} as unknown,
			parserVersion: EXPECTED.parserVersion as unknown,
			serverParserVersion: EXPECTED.serverVersion as unknown,
			producerVersion: EXPECTED.serverVersion,
			parseMode: "txt",
			bundleBytes: 1,
		},
		text: testCase.expect.mustContain.join("\n"),
		statusesSeen: ["queued", "running", "succeeded"],
		job: {
			id: "job",
			sourceArtifactId: "source",
			normalizedArtifactId: "normalized",
			status: "succeeded",
			intakeRoute: "mineru" as string | undefined,
		},
		name: testCase.expect.normalizedName ?? "sample.md",
	};
}

function compareRun(run: ReturnType<typeof faithfulRun>, expected = EXPECTED) {
	return compare(
		run.testCase,
		run.actual,
		run.text,
		run.statusesSeen,
		run.job,
		run.name,
		expected,
	);
}

describe("compare: a MinerU row", () => {
	it("accepts a document that matches its case, for a native one and a PDF alike", () => {
		for (const id of ["docx", "pdf", "paper", "hu-pdf", "png", "tif", "tiff"]) {
			expect(compareRun(faithfulRun(id)), id).toEqual([]);
		}
	});

	it("holds a native document to flash in the result AND in the server's own parse.tier", () => {
		const run = faithfulRun("docx");
		run.actual.jobTier = "standard";
		expect(compareRun(run)).toEqual([
			"jobTier (parse.tier): expected flash, got standard",
		]);
		const other = faithfulRun("docx");
		other.actual.effectiveTier = "standard";
		expect(compareRun(other)).toEqual([
			"effectiveTier: expected flash, got standard",
		]);
	});

	it("resolves the PDF tier from the expectation it is given", () => {
		const run = faithfulRun("pdf");
		expect(compareRun(run, { ...EXPECTED, pdfTier: "basic" })).toEqual([
			"effectiveTier: expected basic, got standard",
			"jobTier (parse.tier): expected basic, got standard",
		]);
	});

	it("holds the app's parser version and MinerU's own version, and an absent one is a mismatch", () => {
		const old = faithfulRun("pdf");
		old.actual.parserVersion = "mineru4/1";
		expect(compareRun(old)).toEqual([
			"extractionParserVersion: expected mineru4/2, got mineru4/1",
		]);
		const server = faithfulRun("pdf");
		server.actual.serverParserVersion = "4.0.12";
		expect(compareRun(server)).toEqual([
			"extractionServerParserVersion (parse.parser_version): expected 4.1.7, got 4.0.12",
		]);
		const missing = faithfulRun("pdf");
		missing.actual.parserVersion = undefined;
		missing.actual.serverParserVersion = undefined;
		expect(compareRun(missing)).toHaveLength(2);
	});

	it("names the block types the renderer did not know, and ignores an empty census", () => {
		const run = faithfulRun("pdf");
		run.actual.unknownBlockTypes = { sidebar: 2, margin_note: 1 };
		expect(compareRun(run)).toEqual([
			"unknown block types: sidebar, margin_note",
		]);
		const none = faithfulRun("pdf");
		none.actual.unknownBlockTypes = undefined;
		expect(compareRun(none)).toEqual([]);
	});

	it("checks the page, figure and outline numbers and the text", () => {
		const run = faithfulRun("paper");
		run.actual.pageCount = 3;
		run.actual.pageCountKind = "declared";
		run.actual.figureCount = 0;
		run.actual.outlineLength = 1;
		run.actual.textLength = 10;
		run.text = "$$";
		const mismatches = compareRun(run);
		expect(mismatches).toContain("pageCount: expected 2, got 3");
		expect(mismatches).toContain(
			"pageCountKind: expected physical, got declared",
		);
		expect(mismatches).toContain("figureCount: expected 1, got 0");
		expect(mismatches).toContain("outline: expected at least 4 entries, got 1");
		expect(mismatches).toContain("textLength: expected at least 1500, got 10");
		expect(mismatches).toContain(
			"missing text: [Figure 1: Figure 1. Relative throughput by tier.]",
		);
		expect(mismatches).toContain("missing text: \\tag{1}");
	});

	it("rejects MinerU's own markup in the text", () => {
		const run = faithfulRun("paper");
		run.text += "\n![](images/page_1_chart_3.jpg)\ndocvortex-page-footnote";
		expect(compareRun(run)).toEqual([
			"unexpected text: ![](",
			"unexpected text: images/page_1_chart",
			"unexpected text: docvortex-page-footnote",
		]);
	});

	it("holds the normalized document to the person's own name", () => {
		const run = faithfulRun("hu-pdf");
		run.name = "document.md";
		expect(compareRun(run)).toEqual([
			"normalized name: expected Árvíztűrő tükörfúrógép jelentés.md, got document.md",
		]);
	});

	it("takes a job on the wrong route for a mineru case, and an absent route for no evidence", () => {
		const run = faithfulRun("pdf");
		run.job.intakeRoute = "direct-text";
		expect(compareRun(run)).toEqual([
			"intakeRoute: expected mineru, got direct-text",
		]);
		const older = faithfulRun("pdf");
		older.job.intakeRoute = undefined;
		expect(compareRun(older)).toEqual([]);
	});
});

describe("compare: a direct-text row (csv and tsv make no MinerU request)", () => {
	it("skips every MinerU-specific field and checks the route, the text and the statuses", () => {
		for (const id of ["csv", "tsv"]) {
			const run = faithfulRun(id);
			run.job.intakeRoute = "direct-text";
			// Nothing MinerU wrote: no tier, no versions, no pages.
			run.actual = {
				...run.actual,
				effectiveTier: undefined as never,
				jobTier: undefined as never,
				pageCount: undefined as never,
				pageCountKind: undefined as never,
				figureCount: undefined as never,
				outlineLength: 0,
				parserVersion: undefined,
				serverParserVersion: undefined,
			};
			run.statusesSeen = ["queued", "succeeded"];
			expect(compareRun(run), id).toEqual([]);
		}
	});

	it("fails a csv that went through MinerU, by route and by the parsing status", () => {
		const run = faithfulRun("csv");
		run.job.intakeRoute = "mineru";
		run.statusesSeen = ["queued", "parsing", "succeeded"];
		expect(compareRun(run)).toEqual([
			"intakeRoute: expected direct-text, got mineru",
			'unexpected status: saw "parsing" (route regressed to mineru?) in [queued, parsing, succeeded]',
		]);
	});
});

describe("preflightProblems: is this the deployment the run was written for", () => {
	const healthy = {
		reachable: true,
		version: "4.1.7",
		tiers: [{ id: "flash" }, { id: "basic" }, { id: "standard" }],
		error: null,
	};

	it("is quiet for the expected version with the expected tier listed", () => {
		expect(preflightProblems(healthy, EXPECTED)).toEqual([]);
	});

	it("says so when the status card could not be read at all", () => {
		expect(preflightProblems(null, EXPECTED)).toEqual([
			"the MinerU status card could not be read",
		]);
	});

	it("names a different MinerU version, including none", () => {
		expect(
			preflightProblems({ ...healthy, version: "4.1.8" }, EXPECTED),
		).toEqual(["MinerU version: expected 4.1.7, the server says 4.1.8"]);
		expect(preflightProblems({ ...healthy, version: null }, EXPECTED)).toEqual([
			"MinerU version: expected 4.1.7, the server says null",
		]);
	});

	it("names a server that does not list the tier PDFs are expected at", () => {
		expect(
			preflightProblems(
				{ ...healthy, tiers: [{ id: "flash" }, { id: "basic" }] },
				EXPECTED,
			),
		).toEqual([
			"the server does not list the tier PDFs and images are expected at (standard)",
		]);
		expect(
			preflightProblems({ ...healthy, tiers: undefined }, EXPECTED),
		).toEqual([
			"the server does not list the tier PDFs and images are expected at (standard)",
		]);
	});

	it("reports both problems when both are there", () => {
		expect(
			preflightProblems(
				{ ...healthy, version: "4.0.12", tiers: [{ id: "flash" }] },
				EXPECTED,
			),
		).toHaveLength(2);
	});
});

describe("failureMismatches: a document MinerU cannot read", () => {
	const corrupt = FAILURE_CASES.find(
		(candidate) => candidate.id === "corrupt-pdf",
	);
	if (!corrupt) throw new Error("no corrupt-pdf case");
	const ours = {
		id: "job",
		sourceArtifactId: "source",
		normalizedArtifactId: null,
		status: "failed",
		retryable: false as boolean | undefined,
		error: {
			code: "document_unreadable" as string | undefined,
			message:
				"This file looks damaged or password-protected. Re-save it and upload it again." as
					| string
					| undefined,
		},
	};

	it("expects document_unreadable, not retryable, from the corrupt PDF", () => {
		expect(corrupt.expect.code).toBe("document_unreadable");
		expect(corrupt.expect.retryable).toBe(false);
	});

	it("accepts a job that failed with the app's own sentence", () => {
		expect(failureMismatches(ours, corrupt.expect)).toEqual([]);
	});

	it("fails a job that is missing or ended any other way", () => {
		expect(failureMismatches(null, corrupt.expect)).toEqual([
			"expected the extraction to fail, it ended missing",
		]);
		expect(
			failureMismatches({ ...ours, status: "succeeded" }, corrupt.expect),
		).toEqual(["expected the extraction to fail, it ended succeeded"]);
	});

	it("fails another code, an offered Retry, an empty sentence, and MinerU's words in it", () => {
		expect(
			failureMismatches(
				{ ...ours, error: { ...ours.error, code: "job_failed" } },
				corrupt.expect,
			),
		).toEqual(["error code: expected document_unreadable, got job_failed"]);
		expect(
			failureMismatches({ ...ours, retryable: true }, corrupt.expect),
		).toEqual(["retryable: expected false, got true"]);
		expect(
			failureMismatches(
				{ ...ours, error: { ...ours.error, message: "" } },
				corrupt.expect,
			),
		).toEqual(["the job carries no error sentence"]);
		expect(
			failureMismatches(
				{
					...ours,
					error: {
						...ours.error,
						message: "Failed to load document (PDFium: Data format error).",
					},
				},
				corrupt.expect,
			),
		).toEqual([
			"MinerU's wording reached the sentence: PDFium",
			"MinerU's wording reached the sentence: Failed to load",
		]);
	});

	it("takes a deployment that does not say `retryable` as no evidence", () => {
		expect(
			failureMismatches({ ...ours, retryable: undefined }, corrupt.expect),
		).toEqual([]);
	});
});

describe("readActual: the metadata keys the sweep reads are the ones the app writes", () => {
	it("finds every value under the key persist.ts stores it under", () => {
		const persist = readFileSync(
			join(process.cwd(), "src/lib/server/services/extraction/persist.ts"),
			"utf8",
		);
		const list = /STRUCTURED_METADATA_KEYS = \[([\s\S]*?)\] as const/.exec(
			persist,
		)?.[1];
		expect(list, "persist.ts keeps its list of structured keys").toBeTruthy();
		const keys = [...(list ?? "").matchAll(/"([A-Za-z]+)"/g)].map(
			(match) => match[1],
		);
		const metadata = Object.fromEntries(keys.map((key) => [key, `v:${key}`]));
		metadata.outline = [{ page: 1 }, { title: "no page" }] as never;

		const actual = readActual({
			id: "normalized",
			name: "sample.md",
			contentText: "abcd",
			metadata,
		});

		expect(actual.effectiveTier).toBe("v:extractionTier");
		expect(actual.jobTier).toBe("v:extractionJobTier");
		expect(actual.pageCount).toBe("v:pageCount");
		expect(actual.pageCountKind).toBe("v:pageCountKind");
		expect(actual.figureCount).toBe("v:extractionFigureCount");
		expect(actual.unknownBlockTypes).toBe("v:extractionUnknownBlockTypes");
		expect(actual.parserVersion).toBe("v:extractionParserVersion");
		expect(actual.serverParserVersion).toBe("v:extractionServerParserVersion");
		expect(actual.producerVersion).toBe("v:extractionProducerVersion");
		expect(actual.parseMode).toBe("v:extractionParseMode");
		expect(actual.bundleBytes).toBe("v:extractionBundleBytes");
		expect(actual.textLength).toBe(4);
		expect(actual.outlineLength).toBe(2);
		expect(actual.outlinePages).toBe(1);
	});

	it("reads an unwritten census as empty", () => {
		expect(
			readActual({ id: "n", name: "n.md", metadata: {} }).unknownBlockTypes,
		).toEqual({});
	});
});

describe("isDirectRun: the sweep starts only when this file is the one run", () => {
	// A guard that is wrongly false turns a live check into a silent no-op that
	// exits 0, so it has to hold when the script is started through a symlinked
	// directory (a checkout reached through a link, or a temp dir that is one).
	function withTree(
		run: (tree: { file: string; viaLink: string; other: string }) => void,
	) {
		const root = mkdtempSync(join(tmpdir(), "sweep-guard-"));
		try {
			const real = join(root, "real");
			mkdirSync(real);
			const file = join(real, "sweep.ts");
			const other = join(real, "other.ts");
			writeFileSync(file, "");
			writeFileSync(other, "");
			const link = join(root, "link");
			symlinkSync(real, link);
			run({ file, viaLink: join(link, "sweep.ts"), other });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("is true for the file itself", () => {
		withTree(({ file }) => {
			expect(isDirectRun(file, pathToFileURL(file).href)).toBe(true);
		});
	});

	it("is true when the path it was started by goes through a symlinked directory", () => {
		withTree(({ file, viaLink }) => {
			expect(isDirectRun(viaLink, pathToFileURL(file).href)).toBe(true);
		});
	});

	it("is true when the module URL is the one that goes through the link", () => {
		withTree(({ file, viaLink }) => {
			expect(isDirectRun(file, pathToFileURL(viaLink).href)).toBe(true);
		});
	});

	it("is false for another file, for no argument, and for a path that does not exist", () => {
		withTree(({ file, other }) => {
			expect(isDirectRun(other, pathToFileURL(file).href)).toBe(false);
			expect(isDirectRun(undefined, pathToFileURL(file).href)).toBe(false);
			expect(isDirectRun(`${file}.missing`, pathToFileURL(file).href)).toBe(
				false,
			);
		});
	});
});

describe("the rows built from the 4.1.7 spike's files, against the real parser", () => {
	// The captured answers the app's own tests run on (`fixtures/mineru-v41`).
	// The rows were first checked this way once, by hand; this keeps them honest
	// when the renderer, the outline or the figure rules change.
	const captured: Array<{ id: string; zip: string; name: string }> = [
		{
			id: "paper",
			zip: join(
				process.cwd(),
				"fixtures/mineru-v41/results/pdf-paper-default-tier/result.zip",
			),
			name: "document.pdf",
		},
		{
			id: "hu-pdf",
			zip: join(process.cwd(), "fixtures/mineru-v41/protocol/zips/v41-pdf.zip"),
			name: "document.pdf",
		},
	];

	it.each(
		captured,
	)("$id holds for what the parser makes of its capture", async ({
		id,
		zip,
		name,
	}) => {
		const { result } = await parseMineruResultZip({
			zipPathAbsolute: zip,
			jobTier: EXPECTED.pdfTier,
			serverParserVersion: EXPECTED.serverVersion,
			sourceFilename: name,
			sourceMimeType: "application/pdf",
		});
		const run = faithfulRun(id);
		const actual = {
			effectiveTier: result.effectiveTier,
			jobTier: EXPECTED.pdfTier,
			pageCount: result.pageCount,
			pageCountKind: result.pageCountKind,
			textLength: result.markdown.length,
			figureCount: result.figures.length,
			outlineLength: result.outline.length,
			outlinePages: result.outline.length,
			unknownBlockTypes: result.stats.unknownTypes as unknown,
			parserVersion: result.parserVersion as unknown,
			serverParserVersion: EXPECTED.serverVersion as unknown,
			producerVersion: result.producerVersion,
			parseMode: result.parseMode,
			bundleBytes: 1,
		};

		expect(
			compare(
				run.testCase,
				actual,
				result.markdown,
				run.statusesSeen,
				run.job,
				run.name,
				EXPECTED,
			),
		).toEqual([]);
	});
});
