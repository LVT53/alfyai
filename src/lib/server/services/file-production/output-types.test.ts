import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES,
	getExpectedExtensionForOutputType,
	isSupportedFileProductionOutputType,
} from "./output-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../../../..", "src");

function read(relative: string): string {
	return readFileSync(path.join(src, relative), "utf8");
}

describe("file-production output types", () => {
	it("accepts every type the model-facing examples name", () => {
		for (const example of FILE_PRODUCTION_OUTPUT_TYPE_EXAMPLES.split(", ")) {
			expect(
				isSupportedFileProductionOutputType(example),
				`${example} is offered to the model but is not a supported type`,
			).toBe(true);
		}
	});

	it("normalizes case and whitespace, and maps MIME strings", () => {
		expect(getExpectedExtensionForOutputType("  XLSX ")).toBe(".xlsx");
		expect(getExpectedExtensionForOutputType("application/pdf")).toBe(".pdf");
		expect(isSupportedFileProductionOutputType("file")).toBe(false);
		expect(isSupportedFileProductionOutputType("gz")).toBe(false);
	});

	// `output-validation.ts` imports JSZip (and its pako tree) to unpack an XLSX.
	// Only the worker needs that. Intake and the `produce_file` tool run on the
	// chat request path and must reach the type table without it — hence this
	// module. A direct `output-validation` import from either would quietly pull
	// JSZip back into the chat server bundle.
	it.each([
		"lib/server/services/file-production/intake.ts",
		"lib/server/services/normal-chat-tools/produce-file.ts",
	])("keeps %s off output-validation (and so off JSZip)", (relative) => {
		expect(read(relative)).not.toMatch(/from\s+"[^"]*output-validation"/);
	});

	it("keeps output-types itself free of heavy dependencies", () => {
		const source = read("lib/server/services/file-production/output-types.ts");
		expect(source).not.toContain("jszip");
		expect(source.match(/^import\s/gm)).toBeNull();
	});
});
