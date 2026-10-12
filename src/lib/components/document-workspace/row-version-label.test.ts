import { describe, expect, it } from "vitest";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { rowVersionLabel } from "./row-version-label";

function doc(overrides: Partial<DocumentWorkspaceItem>): DocumentWorkspaceItem {
	return {
		id: "file-1",
		source: "chat_generated_file",
		filename: "report.pdf",
		title: "Report",
		mimeType: "application/pdf",
		versionNumber: null,
		...overrides,
	};
}

// Ruling 76 (Q2): no number outside History. A row of the workspace's list keeps
// only the "v2" that tells a later copy of a document from an earlier one; the
// first version of a document that has no other version beside it is not "v1",
// it is just the document (FB-8: a generated file's row showed a bare "V1").
describe("rowVersionLabel", () => {
	it("prints nothing for a document with no version number, and invents none for a generated file", () => {
		expect(rowVersionLabel(doc({}), [doc({})])).toBeNull();
		expect(rowVersionLabel(doc({ versionNumber: 0 }), [])).toBeNull();
	});

	it("prints nothing for a first version that stands alone", () => {
		const alone = doc({ versionNumber: 1, documentFamilyId: "family-a" });
		expect(rowVersionLabel(alone, [alone])).toBeNull();
		expect(
			rowVersionLabel(alone, [
				alone,
				doc({ id: "other", versionNumber: 1, documentFamilyId: "family-b" }),
			]),
		).toBeNull();
	});

	it("prints a later version: it is what tells it from the one before", () => {
		const second = doc({ versionNumber: 2, documentFamilyId: "family-a" });
		expect(rowVersionLabel(second, [second])).toBe("v2");
	});

	it("prints the first version too when a later copy of the same document is in the list", () => {
		const first = doc({
			id: "first",
			versionNumber: 1,
			documentFamilyId: "family-a",
		});
		const second = doc({
			id: "second",
			versionNumber: 2,
			documentFamilyId: "family-a",
		});
		expect(rowVersionLabel(first, [first, second])).toBe("v1");
		expect(rowVersionLabel(second, [first, second])).toBe("v2");
	});
});
