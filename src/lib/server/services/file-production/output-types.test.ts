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

	// The table moved to `$lib/shared/file-types` in Phase 1, so the assertion
	// follows it: `table.ts` is the module that must stay dependency-free, and
	// the two modules between it and the request path (`production.ts`, and this
	// module's own re-export shim) must stay off JSZip.
	it("keeps the shared type table free of heavy dependencies", () => {
		const table = read("lib/shared/file-types/table.ts");
		expect(table).not.toMatch(/from\s+"jszip"/i);
		expect(table.match(/^import\s+(?!type\b)/gm)).toBeNull();
	});

	it.each([
		"lib/shared/file-types/production.ts",
		"lib/server/services/file-production/output-types.ts",
	])("keeps %s off JSZip", (relative) => {
		const source = read(relative);
		expect(source).not.toMatch(/from\s+"jszip"/i);
		expect(source).not.toMatch(/from\s+"[^"]*output-validation"/);
	});
});
