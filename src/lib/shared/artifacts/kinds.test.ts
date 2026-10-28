import { describe, expect, it } from "vitest";
import { isShippedArtifactKind, SHIPPED_ARTIFACT_KINDS } from "./kinds";
import { SHIPPED_ARTIFACT_TOUR_TYPES } from "./tours";

// M-3 of the final review: "which kinds ship" was answered by the tours' list
// (`isShippedArtifactTourType`) everywhere, the evidence surface included, so a
// kind that ships without a tour (or whose tour is shelved) would have lost its
// "Made in this chat" rows without a word. The kinds have their own list; the
// tours' list is checked against it.
describe("SHIPPED_ARTIFACT_KINDS", () => {
	it("is Document, App, Canvas and Image — the kinds of the family that ship", () => {
		expect([...SHIPPED_ARTIFACT_KINDS]).toEqual([
			"document",
			"app",
			"canvas",
			"image",
		]);
	});

	it("includes Image, and gives it a tour like the other kinds (plan 2b T16)", () => {
		expect(isShippedArtifactKind("image")).toBe(true);
		expect([...SHIPPED_ARTIFACT_TOUR_TYPES]).toEqual([
			"document",
			"app",
			"canvas",
			"image",
		]);
	});

	it("leaves out Slides (shelved, ruling 69) and File (a produced file, ruling 18)", () => {
		expect(SHIPPED_ARTIFACT_KINDS).not.toContain("slides");
		expect(SHIPPED_ARTIFACT_KINDS).not.toContain("file");
		expect(isShippedArtifactKind("slides")).toBe(false);
		expect(isShippedArtifactKind("file")).toBe(false);
	});

	it("is what every kind with a tour is checked against: no tour for a kind that does not ship", () => {
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			expect(SHIPPED_ARTIFACT_KINDS).toContain(kind);
		}
	});

	it("says yes to each kind on the list", () => {
		for (const kind of SHIPPED_ARTIFACT_KINDS) {
			expect(isShippedArtifactKind(kind)).toBe(true);
		}
	});

	it("narrows by membership, never by a property lookup: object keys and non-strings are not kinds", () => {
		for (const notAKind of [
			"toString",
			"__proto__",
			"constructor",
			"hasOwnProperty",
			"Document",
			"",
		]) {
			expect(isShippedArtifactKind(notAKind)).toBe(false);
		}
		for (const notAString of [undefined, null, 3, {}, [], ["document"]]) {
			expect(isShippedArtifactKind(notAString)).toBe(false);
		}
	});
});
