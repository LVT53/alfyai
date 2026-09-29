import { describe, expect, it } from "vitest";
import {
	currentArtifactVersion,
	NO_OBSERVED_ARTIFACT_VERSIONS,
	observeArtifactVersion,
	withCurrentItemVersion,
	withCurrentSummaryVersion,
} from "./artifact-versions";

describe("observeArtifactVersion", () => {
	it("remembers the newest number the server has told the browser about", () => {
		let observed = NO_OBSERVED_ARTIFACT_VERSIONS;
		observed = observeArtifactVersion(observed, "a1", 2);
		observed = observeArtifactVersion(observed, "a1", 4);
		expect(observed).toEqual({ a1: 4 });
	});

	it("never goes backwards: a slower, older response cannot win over a newer one", () => {
		const observed = observeArtifactVersion(
			observeArtifactVersion(NO_OBSERVED_ARTIFACT_VERSIONS, "a1", 5),
			"a1",
			3,
		);
		expect(observed).toEqual({ a1: 5 });
	});

	it("hands back the same object when nothing changed, so a caller can skip a state write", () => {
		const observed = observeArtifactVersion(
			NO_OBSERVED_ARTIFACT_VERSIONS,
			"a1",
			5,
		);
		expect(observeArtifactVersion(observed, "a1", 5)).toBe(observed);
		expect(observeArtifactVersion(observed, "a1", 4)).toBe(observed);
	});

	it("keeps artifacts apart", () => {
		const observed = observeArtifactVersion(
			observeArtifactVersion(NO_OBSERVED_ARTIFACT_VERSIONS, "a1", 2),
			"a2",
			7,
		);
		expect(observed).toEqual({ a1: 2, a2: 7 });
	});

	it("ignores anything that is not a real version number", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				observeArtifactVersion(NO_OBSERVED_ARTIFACT_VERSIONS, "a1", bad),
			).toBe(NO_OBSERVED_ARTIFACT_VERSIONS);
		}
	});
});

describe("currentArtifactVersion", () => {
	it("is the snapshot when nothing newer was observed", () => {
		expect(currentArtifactVersion({}, "a1", 3)).toBe(3);
		expect(currentArtifactVersion({ a1: 2 }, "a1", 3)).toBe(3);
	});

	it("is the observed number once it is newer than the snapshot", () => {
		expect(currentArtifactVersion({ a1: 5 }, "a1", 3)).toBe(5);
		expect(currentArtifactVersion({ a1: 5 }, "a1", null)).toBe(5);
		expect(currentArtifactVersion({ a1: 5 }, "a1", undefined)).toBe(5);
	});

	it("is null when neither is known", () => {
		expect(currentArtifactVersion({}, "a1", null)).toBeNull();
		expect(currentArtifactVersion({}, "a1", undefined)).toBeNull();
	});
});

describe("withCurrentSummaryVersion", () => {
	const row = {
		id: "a1",
		kind: "document" as const,
		title: "Plan",
		versionNumber: 3,
	};

	it("returns the very same row when nothing newer was observed", () => {
		expect(withCurrentSummaryVersion(row, { a1: 3 })).toBe(row);
		expect(withCurrentSummaryVersion(row, {})).toBe(row);
	});

	it("returns a copy carrying the newer number", () => {
		const next = withCurrentSummaryVersion(row, { a1: 5 });
		expect(next).toEqual({ ...row, versionNumber: 5 });
		expect(next).not.toBe(row);
	});

	it("leaves a produced File alone: its versions are file-production's, not the artifact's", () => {
		const file = { ...row, kind: "file" as const, versionNumber: 0 };
		expect(withCurrentSummaryVersion(file, { a1: 5 })).toBe(file);
	});
});

describe("withCurrentItemVersion", () => {
	const item = {
		id: "artifact:a1",
		artifactId: "a1",
		kind: "document" as const,
		versionNumber: 1,
	};

	it("takes the newer of the saved snapshot and the current number", () => {
		expect(withCurrentItemVersion(item, new Map([["a1", 4]]))).toEqual({
			...item,
			versionNumber: 4,
		});
	});

	it("never lowers a number the snapshot already has", () => {
		expect(withCurrentItemVersion(item, new Map([["a1", 1]]))).toBe(item);
		const newer = { ...item, versionNumber: 6 };
		expect(withCurrentItemVersion(newer, new Map([["a1", 4]]))).toBe(newer);
	});

	it("leaves items that are not artifacts of the family alone", () => {
		const upload = { id: "u1", versionNumber: 2 };
		expect(withCurrentItemVersion(upload, new Map([["u1", 9]]))).toBe(upload);
		const file = { ...item, kind: "file" as const };
		expect(withCurrentItemVersion(file, new Map([["a1", 9]]))).toBe(file);
	});

	it("fills in a missing snapshot number", () => {
		const bare = {
			id: "artifact:a1",
			artifactId: "a1",
			kind: "document" as const,
		};
		expect(withCurrentItemVersion(bare, new Map([["a1", 3]]))).toEqual({
			...bare,
			versionNumber: 3,
		});
	});
});
