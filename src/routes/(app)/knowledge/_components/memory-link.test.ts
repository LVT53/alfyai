import { describe, expect, it } from "vitest";
import { readMemoryLink } from "./memory-link";

const url = (search: string) => new URL(`http://localhost/knowledge${search}`);

describe("readMemoryLink", () => {
	it("reads the scope, entry and search a search result names", () => {
		expect(
			readMemoryLink(
				url(
					"?tab=memory&memoryScope=personal&memoryEntry=row-1&memoryQuery=thesis%20model",
				),
			),
		).toEqual({
			scope: { kind: "personal" },
			entryId: "row-1",
			query: "thesis model",
		});
		expect(
			readMemoryLink(
				url(
					"?tab=memory&memoryScope=project%3Ap%201&memoryEntry=row%202%263&memoryQuery=",
				),
			),
		).toEqual({
			scope: { kind: "project", projectId: "p 1" },
			entryId: "row 2&3",
			query: "",
		});
	});

	it("takes a link that names no entry or no search, as long as it names a scope", () => {
		expect(readMemoryLink(url("?tab=memory&memoryScope=personal"))).toEqual({
			scope: { kind: "personal" },
			entryId: null,
			query: "",
		});
		expect(
			readMemoryLink(url("?tab=memory&memoryScope=personal&memoryEntry=")),
		).toEqual({ scope: { kind: "personal" }, entryId: null, query: "" });
	});

	it("reads nothing from an address that is not a Memory link", () => {
		for (const search of [
			"",
			"?tab=memory",
			"?tab=memory&memoryEntry=row-1",
			"?tab=memory&memoryScope=project",
			"?tab=memory&memoryScope=project%3A",
			"?tab=memory&memoryScope=garden",
			"?tab=documents&memoryScope=personal&memoryEntry=row-1",
			"?memoryScope=personal&memoryEntry=row-1",
		]) {
			expect(readMemoryLink(url(search)), search).toBeNull();
		}
	});
});
