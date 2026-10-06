import { describe, expect, it } from "vitest";
import {
	ARTIFACT_TOUR_SLIDE_COUNT,
	isShippedArtifactTourType,
	SHIPPED_ARTIFACT_TOUR_TYPES,
} from "./tours";

describe("the kinds whose tour ships (ruling 69)", () => {
	it("is Document, App and Canvas, in that order, and nothing else", () => {
		expect([...SHIPPED_ARTIFACT_TOUR_TYPES]).toEqual([
			"document",
			"app",
			"canvas",
		]);
	});

	it("leaves Slides out while Slides is shelved, and File out for good (ruling 8)", () => {
		expect(SHIPPED_ARTIFACT_TOUR_TYPES).not.toContain("slides");
		expect(SHIPPED_ARTIFACT_TOUR_TYPES).not.toContain("file");
		expect(isShippedArtifactTourType("slides")).toBe(false);
		expect(isShippedArtifactTourType("file")).toBe(false);
	});

	it("narrows exactly the shipped kinds, and refuses everything else a path segment can be", () => {
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			expect(isShippedArtifactTourType(kind)).toBe(true);
		}
		for (const notAKind of [
			"",
			"Document",
			"CANVAS",
			" canvas",
			"canvas ",
			"bogus",
			// Inherited Object.prototype keys: a lookup in an object literal would
			// say yes to these, a membership test on the list does not.
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(isShippedArtifactTourType(notAKind)).toBe(false);
		}
		for (const notAString of [undefined, null, 0, {}, ["canvas"]]) {
			expect(isShippedArtifactTourType(notAString)).toBe(false);
		}
	});

	it("says a tour is three slides, once", () => {
		expect(ARTIFACT_TOUR_SLIDE_COUNT).toBe(3);
	});
});
