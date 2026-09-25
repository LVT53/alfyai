import { describe, expect, it } from "vitest";
import type { ArtifactType } from "./types";

// Item 9 of the client review: the artifact family (Feature 2, ADR-0066)
// writes real `artifacts` rows with `type: "artifact"` (record.ts's
// ARTIFACT_ROW_TYPE), but ArtifactType excluded that value — every reader
// that maps a raw row through `row.type as ArtifactType`
// (store/core.ts's mapArtifactSummary) was casting a real "artifact" row
// into a union that had no honest name for it.
//
// This is a compile-time regression test as much as a runtime one: if
// "artifact" is ever removed from ArtifactType again, the assignment below
// stops compiling and `npm run check` catches it, the same way it would
// catch a missing case in an exhaustive switch.
describe("ArtifactType", () => {
	it("includes 'artifact', the family's own row type", () => {
		const kind: ArtifactType = "artifact";
		expect(kind).toBe("artifact");
	});
});
