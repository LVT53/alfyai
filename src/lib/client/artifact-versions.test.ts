import { describe, expect, it } from "vitest";
import {
	currentArtifactMoment,
	dropDeletedArtifacts,
	forgetObservedArtifact,
	markArtifactDeleted,
	NO_OBSERVED_ARTIFACT_MOMENTS,
	observeArtifactMoment,
	readLatestMoment,
	withCurrentItemMoment,
	withCurrentSummaryMoment,
} from "./artifact-versions";

// Ruling 76, amendment A1: ONE latest moment on every surface. The number still
// orders and guards (a response that arrives late can never pull a surface
// backwards), but what the surfaces say is the moment: when, who, what.

describe("observeArtifactMoment", () => {
	it("remembers the newest version with its time, author and kind", () => {
		const seen = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1000,
			author: "alfy",
			kind: "alfy_edit",
		});
		expect(seen).toEqual({
			a1: { version: 3, at: 1000, author: "alfy", kind: "alfy_edit" },
		});
	});

	it("never goes backwards: a slower, older response cannot win over a newer one", () => {
		const newer = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 5,
			at: 5000,
			author: "user",
			kind: "restore",
		});
		const afterOlder = observeArtifactMoment(newer, "a1", {
			version: 4,
			at: 9999,
			author: "alfy",
			kind: "alfy_edit",
		});
		expect(afterOlder).toBe(newer);
	});

	it("takes the whole moment of a newer version, not the old author with the new number", () => {
		const first = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1000,
			author: "alfy",
			kind: "alfy_edit",
		});
		const second = observeArtifactMoment(first, "a1", {
			version: 4,
			at: 2000,
			author: "user",
			kind: "undo_alfy_change",
		});
		expect(second.a1).toEqual({
			version: 4,
			at: 2000,
			author: "user",
			kind: "undo_alfy_change",
		});
	});

	it("fills in what an earlier announcement of the same version did not know, and lets the time move forward", () => {
		const bare = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: null,
		});
		expect(bare.a1).toEqual({ version: 3, at: null, author: null, kind: null });
		const told = observeArtifactMoment(bare, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "user_edit",
		});
		expect(told.a1).toEqual({
			version: 3,
			at: 1500,
			author: "user",
			kind: "user_edit",
		});
		// A typing burst saves into the same version again: later, same moment.
		const later = observeArtifactMoment(told, "a1", {
			version: 3,
			at: 1900,
			author: "user",
			kind: "user_edit",
		});
		expect(later.a1?.at).toBe(1900);
		// An earlier time is not an observation.
		expect(observeArtifactMoment(later, "a1", { version: 3, at: 1600 })).toBe(
			later,
		);
	});

	it("does not forget a known author or kind because a later response of the same version does not say", () => {
		const told = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "restore",
		});
		const afterSilent = observeArtifactMoment(told, "a1", {
			version: 3,
			at: 1500,
		});
		expect(afterSilent).toBe(told);
	});

	it("lets a more specific announcement of the same version refine the kind (a tick is an edit that only flipped a box)", () => {
		const edit = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "user_edit",
		});
		const tick = observeArtifactMoment(edit, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "tick",
		});
		expect(tick.a1?.kind).toBe("tick");
	});

	it("carries the previous time over a newer version that does not say when (a version list's newest row)", () => {
		const first = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "user_edit",
		});
		const second = observeArtifactMoment(first, "a1", {
			version: 4,
			at: null,
		});
		expect(second.a1).toEqual({
			version: 4,
			at: 1500,
			author: null,
			kind: null,
		});
	});

	it("hands back the same object when nothing changed, so a caller can skip a state write", () => {
		const first = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1000,
			author: "alfy",
			kind: "alfy_edit",
		});
		expect(
			observeArtifactMoment(first, "a1", {
				version: 3,
				at: 1000,
				author: "alfy",
				kind: "alfy_edit",
			}),
		).toBe(first);
	});

	it("keeps artifacts apart", () => {
		const first = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1,
		});
		const second = observeArtifactMoment(first, "a2", { version: 1, at: 2 });
		expect(second.a1?.version).toBe(3);
		expect(second.a2?.version).toBe(1);
	});

	it("ignores anything that is not a real version number, and anything that is not a time", () => {
		for (const version of [0, -1, 1.5, Number.NaN]) {
			expect(
				observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
					version,
					at: 1000,
				}),
			).toBe(NO_OBSERVED_ARTIFACT_MOMENTS);
		}
		const seen = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 2,
			at: Number.NaN,
		});
		expect(seen.a1?.at).toBeNull();
		const zero = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 2,
			at: 0,
		});
		expect(zero.a1?.at).toBeNull();
	});
});

describe("currentArtifactMoment", () => {
	it("is the snapshot when nothing newer was observed", () => {
		expect(
			currentArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
				version: 3,
				at: 1000,
				author: "alfy",
				kind: "first_draft",
			}),
		).toEqual({ version: 3, at: 1000, author: "alfy", kind: "first_draft" });
	});

	it("is the observed moment once its version is newer than the snapshot's", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 5,
			at: 5000,
			author: "user",
			kind: "restore",
		});
		expect(
			currentArtifactMoment(observed, "a1", {
				version: 3,
				at: 9000,
				author: "alfy",
				kind: "alfy_edit",
			}),
		).toEqual({ version: 5, at: 5000, author: "user", kind: "restore" });
	});

	it("is the snapshot when the snapshot is newer than what was observed (a list refresh after the write)", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1000,
			author: "user",
			kind: "user_edit",
		});
		expect(
			currentArtifactMoment(observed, "a1", {
				version: 4,
				at: 2000,
				author: "alfy",
				kind: "alfy_edit",
			}),
		).toEqual({ version: 4, at: 2000, author: "alfy", kind: "alfy_edit" });
	});

	it("on the same version takes what is known from either side and the later time", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 3,
			at: 1500,
			author: "user",
			kind: "user_edit",
		});
		expect(
			currentArtifactMoment(observed, "a1", {
				version: 3,
				at: 1000,
				author: null,
				kind: null,
			}),
		).toEqual({ version: 3, at: 1500, author: "user", kind: "user_edit" });
		expect(
			currentArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
				version: 3,
				at: 1000,
				author: "alfy",
				kind: null,
			}),
		).toEqual({ version: 3, at: 1000, author: "alfy", kind: null });
	});

	it("is null when neither is known", () => {
		expect(
			currentArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", null),
		).toBeNull();
	});
});

describe("readLatestMoment", () => {
	it("reads the latest moment off any row or item that carries it, null where it does not", () => {
		expect(
			readLatestMoment({
				versionNumber: 4,
				updatedAt: 800,
				lastAuthor: "alfy",
				lastKind: "alfy_edit",
			}),
		).toEqual({ version: 4, at: 800, author: "alfy", kind: "alfy_edit" });
		expect(readLatestMoment({ versionNumber: 4, updatedAt: 800 })).toEqual({
			version: 4,
			at: 800,
			author: null,
			kind: null,
		});
		expect(readLatestMoment({})).toBeNull();
		expect(readLatestMoment({ versionNumber: 0, updatedAt: 0 })).toBeNull();
	});
});

describe("withCurrentSummaryMoment", () => {
	const row = {
		id: "a1",
		kind: "document",
		versionNumber: 2,
		updatedAt: 1000,
	};

	it("returns the very same row when nothing newer was observed", () => {
		expect(withCurrentSummaryMoment(row, NO_OBSERVED_ARTIFACT_MOMENTS)).toBe(
			row,
		);
	});

	it("returns a copy carrying the newer number, time, author and kind", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 5,
			at: 5000,
			author: "alfy",
			kind: "alfy_edit",
		});
		expect(withCurrentSummaryMoment(row, observed)).toEqual({
			...row,
			versionNumber: 5,
			updatedAt: 5000,
			lastAuthor: "alfy",
			lastKind: "alfy_edit",
		});
	});

	it("takes author and kind from the observation even when the row already holds the same version (the row's own were not known)", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 2,
			at: 1000,
			author: "user",
			kind: "user_edit",
		});
		expect(withCurrentSummaryMoment(row, observed)).toEqual({
			...row,
			lastAuthor: "user",
			lastKind: "user_edit",
		});
	});

	it("never lowers what the row already says", () => {
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
			version: 1,
			at: 10,
			author: "alfy",
			kind: "first_draft",
		});
		expect(withCurrentSummaryMoment(row, observed)).toBe(row);
	});

	it("leaves a produced File alone: its versions are file-production's, not the artifact's", () => {
		const file = { id: "f1", kind: "file", versionNumber: 1, updatedAt: 10 };
		const observed = observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "f1", {
			version: 9,
			at: 99,
			author: "alfy",
			kind: "alfy_edit",
		});
		expect(withCurrentSummaryMoment(file, observed)).toBe(file);
	});
});

describe("withCurrentItemMoment", () => {
	const item = {
		artifactId: "a1",
		kind: "document" as const,
		versionNumber: 2,
		updatedAt: 1000,
	};

	it("takes the newer of the saved snapshot and the current moment", () => {
		const current = new Map([
			[
				"a1",
				{
					version: 5,
					at: 5000,
					author: "alfy" as const,
					kind: "alfy_edit" as const,
				},
			],
		]);
		expect(withCurrentItemMoment(item, current)).toEqual({
			...item,
			versionNumber: 5,
			updatedAt: 5000,
			lastAuthor: "alfy",
			lastKind: "alfy_edit",
		});
	});

	it("never lowers what the snapshot already has", () => {
		const current = new Map([
			["a1", { version: 1, at: 10, author: null, kind: null }],
		]);
		expect(withCurrentItemMoment(item, current)).toBe(item);
	});

	it("leaves items that are not artifacts of the family alone", () => {
		const current = new Map([
			["a1", { version: 9, at: 9000, author: null, kind: null }],
		]);
		const plain = { artifactId: null, kind: "file" as const };
		expect(withCurrentItemMoment(plain, current)).toBe(plain);
		const file = { artifactId: "a1", kind: "file" as const, versionNumber: 1 };
		expect(withCurrentItemMoment(file, current)).toBe(file);
	});

	it("fills in a snapshot that carries no number or time", () => {
		const current = new Map([
			[
				"a1",
				{
					version: 4,
					at: 4000,
					author: "user" as const,
					kind: "restore" as const,
				},
			],
		]);
		const bare = { artifactId: "a1", kind: "document" as const };
		expect(withCurrentItemMoment(bare, current)).toEqual({
			...bare,
			versionNumber: 4,
			updatedAt: 4000,
			lastAuthor: "user",
			lastKind: "restore",
		});
	});
});

describe("markArtifactDeleted / dropDeletedArtifacts", () => {
	it("adds an id once, handing back the same list when it was already there", () => {
		const first = markArtifactDeleted([], "a1");
		expect(first).toEqual(["a1"]);
		expect(markArtifactDeleted(first, "a1")).toBe(first);
		expect(markArtifactDeleted(first, "a2")).toEqual(["a1", "a2"]);
	});

	it("forgets what was heard about a deleted artifact, so a copy made later under the same id starts from its own moment", () => {
		const heard = observeArtifactMoment(
			observeArtifactMoment(NO_OBSERVED_ARTIFACT_MOMENTS, "a1", {
				version: 7,
				at: 9000,
			}),
			"a2",
			{ version: 2, at: 100 },
		);
		expect(Object.keys(forgetObservedArtifact(heard, "a1"))).toEqual(["a2"]);
		// Nothing heard about it: the same object, no state write.
		expect(forgetObservedArtifact(heard, "nope")).toBe(heard);
	});

	it("drops deleted rows from a list, keeping the same array when none is affected", () => {
		const rows = [{ id: "a1" }, { id: "a2" }];
		expect(dropDeletedArtifacts(rows, ["a2"])).toEqual([{ id: "a1" }]);
		expect(dropDeletedArtifacts(rows, [])).toBe(rows);
		expect(dropDeletedArtifacts(rows, ["zzz"])).toBe(rows);
	});
});
