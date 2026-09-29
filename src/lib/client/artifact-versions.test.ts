import { describe, expect, it } from "vitest";
import {
	currentArtifactVersion,
	dropDeletedArtifacts,
	forgetObservedArtifact,
	markArtifactDeleted,
	NO_OBSERVED_ARTIFACT_TIMES,
	NO_OBSERVED_ARTIFACT_VERSIONS,
	observeArtifactUpdatedAt,
	observeArtifactVersion,
	withCurrentItemUpdatedAt,
	withCurrentItemVersion,
	withCurrentSummaryUpdatedAt,
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

// Polish G2-A: the time of the last change follows the same rule as the
// version — the latest the browser has heard, never an older one — so the
// header's "edited 2 min ago" and the list row's time stay live too.
describe("observeArtifactUpdatedAt", () => {
	it("remembers the latest change time the browser has heard about", () => {
		let observed = NO_OBSERVED_ARTIFACT_TIMES;
		observed = observeArtifactUpdatedAt(observed, "a1", 1000);
		observed = observeArtifactUpdatedAt(observed, "a1", 3000);
		expect(observed).toEqual({ a1: 3000 });
	});

	it("never goes backwards, and hands back the same object when nothing changed", () => {
		const observed = observeArtifactUpdatedAt(
			NO_OBSERVED_ARTIFACT_TIMES,
			"a1",
			3000,
		);
		expect(observeArtifactUpdatedAt(observed, "a1", 2000)).toBe(observed);
		expect(observeArtifactUpdatedAt(observed, "a1", 3000)).toBe(observed);
	});

	it("ignores a response that does not say when, and anything that is not a time", () => {
		for (const bad of [
			null,
			undefined,
			0,
			-5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(
				observeArtifactUpdatedAt(NO_OBSERVED_ARTIFACT_TIMES, "a1", bad),
			).toBe(NO_OBSERVED_ARTIFACT_TIMES);
		}
	});
});

describe("withCurrentSummaryUpdatedAt", () => {
	const row = { id: "a1", kind: "document" as const, updatedAt: 1000 };

	it("returns the very same row when nothing newer was heard", () => {
		expect(withCurrentSummaryUpdatedAt(row, { a1: 1000 })).toBe(row);
		expect(withCurrentSummaryUpdatedAt(row, { a1: 900 })).toBe(row);
		expect(withCurrentSummaryUpdatedAt(row, {})).toBe(row);
	});

	it("returns a copy carrying the newer time", () => {
		const next = withCurrentSummaryUpdatedAt(row, { a1: 5000 });
		expect(next).toEqual({ ...row, updatedAt: 5000 });
		expect(next).not.toBe(row);
	});
});

describe("withCurrentItemUpdatedAt", () => {
	const item = {
		id: "artifact:a1",
		artifactId: "a1",
		kind: "document" as const,
		updatedAt: 1000,
	};

	it("takes the newer of the saved snapshot's time and the current one", () => {
		expect(withCurrentItemUpdatedAt(item, new Map([["a1", 4000]]))).toEqual({
			...item,
			updatedAt: 4000,
		});
		expect(withCurrentItemUpdatedAt(item, new Map([["a1", 500]]))).toBe(item);
	});

	it("fills in a snapshot that carries no time, and leaves a plain file item alone", () => {
		const bare = {
			id: "artifact:a1",
			artifactId: "a1",
			kind: "document" as const,
		};
		expect(withCurrentItemUpdatedAt(bare, new Map([["a1", 4000]]))).toEqual({
			...bare,
			updatedAt: 4000,
		});
		const upload = { id: "u1", updatedAt: 1 };
		expect(withCurrentItemUpdatedAt(upload, new Map([["u1", 9]]))).toBe(upload);
	});
});

describe("markArtifactDeleted / dropDeletedArtifacts", () => {
	it("adds an id once, handing back the same list when it was already there", () => {
		const first = markArtifactDeleted([], "a1");
		expect(first).toEqual(["a1"]);
		expect(markArtifactDeleted(first, "a1")).toBe(first);
		expect(markArtifactDeleted(first, "a2")).toEqual(["a1", "a2"]);
	});

	it("forgets what was heard about a deleted artifact, so a copy made later under the same id starts from its own numbers", () => {
		const versions = { a1: 7, a2: 2 };
		const times = { a1: 9000, a2: 100 };
		expect(forgetObservedArtifact(versions, "a1")).toEqual({ a2: 2 });
		expect(forgetObservedArtifact(times, "a1")).toEqual({ a2: 100 });
		// Nothing heard about it: the same object, no state write.
		expect(forgetObservedArtifact(versions, "nope")).toBe(versions);
	});

	it("drops deleted rows from a list, keeping the same array when none is affected", () => {
		const rows = [{ id: "a1" }, { id: "a2" }];
		expect(dropDeletedArtifacts(rows, ["a2"])).toEqual([{ id: "a1" }]);
		expect(dropDeletedArtifacts(rows, [])).toBe(rows);
		expect(dropDeletedArtifacts(rows, ["zzz"])).toBe(rows);
	});
});
