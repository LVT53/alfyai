import { describe, expect, it } from "vitest";
import { parseDocument } from "$lib/shared/artifact-document/blocks";
import {
	createBody,
	documentSerializer,
	hashBody,
	parse,
	serialize,
} from "./document";

describe("document serializer", () => {
	it("createBody mints ids and returns text that is already canonical", () => {
		const body = createBody({
			title: "Trip",
			markdown: "# Trip\n\nPlan the days.",
		});
		expect(body.markdown).toContain("<!--b:");
		expect(body.tabs).toHaveLength(1);
		expect(body.tabs[0].title).toBe("Trip");
		expect(body.tabs[0].startBlockId.length).toBeGreaterThan(0);

		// createBody's own output must already be through parseDocument, so a
		// second parse mints nothing new (Contracts: "mint/absorb immediately
		// after parse — before hashing, snapshotting or rendering").
		const reparsed = parseDocument(body.markdown);
		expect(reparsed.minted).toBe(false);
	});

	it("gives a fresh empty document one tab with no starting block yet", () => {
		const body = createBody({ title: "Untitled" });
		expect(body.markdown).toBe("");
		expect(body.tabs).toHaveLength(1);
		expect(body.tabs[0].startBlockId).toBe("");
	});

	it("round-trips through parse(serialize(body))", () => {
		const body = createBody({ title: "Notes", markdown: "Some notes." });
		const roundTripped = parse(serialize(body));
		expect(roundTripped?.markdown).toBe(body.markdown);
	});

	it("parses a body with a marker in it rather than trusting it verbatim", () => {
		const result = parse("<!--b:p00001-->\nHello");
		expect(result).not.toBeNull();
		expect(result?.markdown).toContain("<!--b:p00001-->");
		expect(result?.markdown).toContain("Hello");
	});

	it("hashBody is hashArtifactBody of the serialised text, the family's one hasher", () => {
		const body = createBody({ title: "Notes", markdown: "Some notes." });
		expect(hashBody(body)).toBe(hashBody({ ...body, tabs: [...body.tabs] }));
		expect(typeof hashBody(body)).toBe("string");
		expect(hashBody(body).length).toBeGreaterThan(0);
		// Two different bodies must not collide.
		const other = createBody({ title: "Notes", markdown: "Other notes." });
		expect(hashBody(body)).not.toBe(hashBody(other));
	});

	it("registers under the document kind", () => {
		expect(documentSerializer.kind).toBe("document");
		expect(documentSerializer.serialize).toBe(serialize);
		expect(documentSerializer.parse).toBe(parse);
	});
});
