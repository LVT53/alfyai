import { describe, expect, it } from "vitest";
import {
	buildSearchScopeChips,
	filterRowsByScope,
	isScopeAvailable,
	resolveActiveScope,
	rowMatchesScope,
	SEARCH_SCOPE_ORDER,
	type ScopeableRow,
	summariseScopedResults,
} from "./search-scopes";

const conversation: ScopeableRow = { id: "c1", kind: "conversation" };
const otherConversation: ScopeableRow = { id: "c2", kind: "conversation" };
const uploaded: ScopeableRow = {
	id: "d1",
	kind: "document",
	documentOrigin: "uploaded",
};
const skillNote: ScopeableRow = {
	id: "d2",
	kind: "document",
	documentOrigin: "skill_note",
};
const generated: ScopeableRow = {
	id: "d3",
	kind: "document",
	documentOrigin: "generated",
};
const overflow: ScopeableRow = { id: "overflow", kind: "knowledge-overflow" };

const rows = [
	conversation,
	otherConversation,
	uploaded,
	skillNote,
	generated,
	overflow,
];

describe("SEARCH_SCOPE_ORDER", () => {
	it("leads with All and ends with the two new kinds", () => {
		expect(SEARCH_SCOPE_ORDER).toEqual([
			"all",
			"conversations",
			"documents",
			"reports",
			"connections",
		]);
	});
});

describe("isScopeAvailable", () => {
	it("marks connections as the one scope nothing indexes", () => {
		expect(isScopeAvailable("all")).toBe(true);
		expect(isScopeAvailable("conversations")).toBe(true);
		expect(isScopeAvailable("documents")).toBe(true);
		expect(isScopeAvailable("reports")).toBe(true);
		expect(isScopeAvailable("connections")).toBe(false);
	});
});

describe("rowMatchesScope", () => {
	it("keeps everything under All", () => {
		for (const row of rows) {
			expect(rowMatchesScope(row, "all")).toBe(true);
		}
	});

	it("narrows conversations to conversation rows", () => {
		expect(rowMatchesScope(conversation, "conversations")).toBe(true);
		expect(rowMatchesScope(uploaded, "conversations")).toBe(false);
		expect(rowMatchesScope(overflow, "conversations")).toBe(false);
	});

	it("keeps the Knowledge overflow row wherever documents are shown", () => {
		expect(rowMatchesScope(overflow, "documents")).toBe(true);
		expect(rowMatchesScope(overflow, "reports")).toBe(false);
	});

	it("treats a generated document as the report it is", () => {
		expect(rowMatchesScope(generated, "reports")).toBe(true);
		expect(rowMatchesScope(uploaded, "reports")).toBe(false);
		expect(rowMatchesScope(skillNote, "reports")).toBe(false);
		expect(rowMatchesScope(conversation, "reports")).toBe(false);
	});

	it("matches nothing under connections, because nothing is indexed", () => {
		for (const row of rows) {
			expect(rowMatchesScope(row, "connections")).toBe(false);
		}
	});
});

describe("filterRowsByScope", () => {
	it("returns a copy under All rather than the same array", () => {
		const filtered = filterRowsByScope(rows, "all");
		expect(filtered).toEqual(rows);
		expect(filtered).not.toBe(rows);
	});

	it("narrows to documents including the overflow row", () => {
		expect(filterRowsByScope(rows, "documents").map((row) => row.id)).toEqual([
			"d1",
			"d2",
			"d3",
			"overflow",
		]);
	});

	it("narrows to reports", () => {
		expect(filterRowsByScope(rows, "reports").map((row) => row.id)).toEqual([
			"d3",
		]);
	});
});

describe("buildSearchScopeChips", () => {
	it("counts each scope over the loaded results", () => {
		const chips = buildSearchScopeChips(rows);
		const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip]));
		// The overflow row is a way out, not a result — never counted.
		expect(byId.all.count).toBe(5);
		expect(byId.conversations.count).toBe(2);
		expect(byId.documents.count).toBe(3);
		expect(byId.reports.count).toBe(1);
	});

	it("draws connections greyed with no count", () => {
		const chips = buildSearchScopeChips(rows);
		const connections = chips.find((chip) => chip.id === "connections");
		expect(connections).toEqual({
			id: "connections",
			count: 0,
			available: false,
		});
	});

	it("returns every scope even with nothing loaded", () => {
		const chips = buildSearchScopeChips([]);
		expect(chips.map((chip) => chip.id)).toEqual([...SEARCH_SCOPE_ORDER]);
		expect(chips.every((chip) => chip.count === 0)).toBe(true);
	});
});

describe("resolveActiveScope", () => {
	const chips = buildSearchScopeChips(rows);

	it("keeps a scope that has results", () => {
		expect(resolveActiveScope("reports", chips)).toBe("reports");
	});

	it("falls back to All for the unavailable scope", () => {
		expect(resolveActiveScope("connections", chips)).toBe("all");
	});

	it("falls back to All once a scope empties out", () => {
		const emptied = buildSearchScopeChips([conversation]);
		expect(resolveActiveScope("documents", emptied)).toBe("all");
	});

	it("leaves All alone", () => {
		expect(resolveActiveScope("all", buildSearchScopeChips([]))).toBe("all");
	});
});

describe("summariseScopedResults", () => {
	it("counts results across kinds, ignoring the overflow row", () => {
		expect(summariseScopedResults(rows)).toEqual({ results: 5, kinds: 3 });
	});

	it("counts one kind when only conversations came back", () => {
		expect(summariseScopedResults([conversation, otherConversation])).toEqual({
			results: 2,
			kinds: 1,
		});
	});

	it("is empty for no rows", () => {
		expect(summariseScopedResults([])).toEqual({ results: 0, kinds: 0 });
	});
});
