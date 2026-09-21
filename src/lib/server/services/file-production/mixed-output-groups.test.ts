import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MIXED_OUTPUT_GROUPS_ERROR_CODE,
	refuseMixedOutputGroups,
} from "./mixed-output-groups";

/**
 * The message the model reads. Frozen here, byte for byte, because moving the
 * predicate out of `normal-chat-tools/produce-file.ts` must not reword
 * anything the model has already been taught to act on.
 */
const FROZEN_PDF_MD_MESSAGE =
	"Cannot produce pdf, md from one request. " +
	"Request one group of formats at a time: PDF, DOCX and HTML are rendered from a document source, " +
	"while md, txt, csv, tsv, json and code files are written as plain text. " +
	"Call produce_file once for pdf (send documentSource, or content with only those formats in requestedOutputs), " +
	"and again for md.";

describe("refuseMixedOutputGroups", () => {
	it("keeps the model-facing message byte-identical", () => {
		expect(refuseMixedOutputGroups(["pdf", "md"])?.error).toBe(
			FROZEN_PDF_MD_MESSAGE,
		);
		expect(refuseMixedOutputGroups(["pdf", "md"])?.code).toBe(
			MIXED_OUTPUT_GROUPS_ERROR_CODE,
		);
	});

	it.each([
		[["pdf", "md"]],
		[["docx", "txt"]],
		[["html", "md"]],
		[["pdf", "csv"]],
		[["md", "pdf", "txt"]],
	])("refuses %j", (types) => {
		expect(refuseMixedOutputGroups(types)).not.toBeNull();
	});

	it.each([
		[[]],
		[["pdf"]],
		[["md"]],
		[["pdf", "docx"]],
		[["pdf", "docx", "html"]],
		[["md", "csv", "tsv", "json"]],
		[["xlsx", "pptx"]],
	])("allows %j", (types) => {
		expect(refuseMixedOutputGroups(types)).toBeNull();
	});

	/**
	 * `xlsx` and `zip` are neither document sources nor inline text. They are
	 * "not a document source", so they group with the text family here — which
	 * is correct for this rule's only job (deciding whether ONE writer can
	 * serve the whole request): a program writes both.
	 */
	it("treats binary program outputs as one group with text outputs", () => {
		expect(refuseMixedOutputGroups(["xlsx", "csv"])).toBeNull();
		expect(refuseMixedOutputGroups(["pdf", "xlsx"])).not.toBeNull();
	});
});

describe("architecture boundary", () => {
	const source = readFileSync(
		join(process.cwd(), "src/lib/server/services/file-production/intake.ts"),
		"utf8",
	);

	it("lets intake reach the rule without importing the tools layer", () => {
		expect(source).toContain("./mixed-output-groups");
		expect(source).not.toContain("normal-chat-tools");
	});

	it("keeps intake free of the heavy production modules", () => {
		for (const heavy of [
			"./worker-runner",
			"./execution-adapter",
			"./storage-adapter",
			"./renderers/",
			"$lib/server/services/chat-files",
			"$lib/server/sandbox",
		]) {
			expect(source).not.toContain(heavy);
		}
	});

	it("keeps the rule itself a leaf", () => {
		const rule = readFileSync(
			join(
				process.cwd(),
				"src/lib/server/services/file-production/mixed-output-groups.ts",
			),
			"utf8",
		);
		const imports = [...rule.matchAll(/^import .* from "(.+)";$/gm)].map(
			(match) => match[1],
		);
		expect(imports).toEqual(["$lib/shared/file-types/production"]);
	});
});
