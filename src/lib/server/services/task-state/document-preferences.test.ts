import { describe, expect, it } from "vitest";
import { findConflictingDocumentPreferenceArtifactIds } from "./document-preferences";

describe("task-state document preference conflicts", () => {
	it("returns sibling artifact ids from the same document family", () => {
		expect(
			findConflictingDocumentPreferenceArtifactIds({
				entries: [
					{
						artifactId: "artifact-v1",
						metadata: { documentFamilyId: "family-brief" },
					},
					{
						artifactId: "artifact-v2",
						metadata: { documentFamilyId: "family-brief" },
					},
					{
						artifactId: "artifact-slides",
						metadata: { documentFamilyId: "family-slides" },
					},
				],
				targetArtifactId: "artifact-v2",
				targetFamilyId: "family-brief",
			}),
		).toEqual(["artifact-v1"]);
	});

	it("returns no conflicts when the target has no family id", () => {
		expect(
			findConflictingDocumentPreferenceArtifactIds({
				entries: [
					{
						artifactId: "artifact-v1",
						metadata: { documentFamilyId: "family-brief" },
					},
				],
				targetArtifactId: "artifact-v1",
				targetFamilyId: null,
			}),
		).toEqual([]);
	});
});
