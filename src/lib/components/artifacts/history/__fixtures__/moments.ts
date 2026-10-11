/**
 * Test-only fixtures of `ArtifactMoment`s (the shape VB-1's history route
 * answers with, `shared/artifacts/history.ts`). The History UI was built
 * against these until the route landed. Not for production code.
 */
import type {
	ArtifactMoment,
	ArtifactMomentStep,
} from "$lib/shared/artifacts/history";

let counter = 0;

/** A local time: `at(2026, 10, 11, 10, 9)` is 11 October 2026, 10:09, wherever the tests run. */
export function at(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

export function makeMoment(
	overrides: Partial<ArtifactMoment> & { versionNumber: number },
): ArtifactMoment {
	counter += 1;
	const versionNumber = overrides.versionNumber;
	return {
		versionId: `v${versionNumber}`,
		parentVersionId: versionNumber > 1 ? `v${versionNumber - 1}` : null,
		parentVersionNumber: versionNumber > 1 ? versionNumber - 1 : null,
		kind: "user_edit",
		author: "user",
		fold: null,
		quiet: false,
		at: at(2026, 10, 11, 10, counter % 60),
		startedAt: null,
		label: null,
		text: null,
		tick: null,
		target: null,
		restoredFrom: null,
		commentId: null,
		detail: { type: "none" },
		status: null,
		undoneBy: null,
		isNewest: false,
		containsNewest: false,
		sameAsNow: false,
		sameAs: null,
		restoredHere: [],
		bodyHash: `hash-${versionNumber}`,
		steps: [],
		...overrides,
		versionNumber,
	};
}

export function makeStep(
	overrides: Partial<ArtifactMomentStep> & { versionNumber: number },
): ArtifactMomentStep {
	const versionNumber = overrides.versionNumber;
	return {
		versionId: `v${versionNumber}`,
		kind: "undo_alfy_change",
		author: "user",
		at: at(2026, 10, 11, 10, 13),
		text: null,
		label: null,
		isNewest: false,
		sameAsNow: false,
		sameAs: null,
		parentVersionId: `v${versionNumber - 1}`,
		parentVersionNumber: versionNumber - 1,
		...overrides,
		versionNumber,
	};
}

/**
 * A small Document story, newest first (versioning.md §3.3): Alfy's first draft
 * (v1), a burst of the reader's typing (v3), then an Alfy change (v4) that the
 * reader undid at once (v5), folded onto it. The tests that need more build
 * their own list.
 */
export function oneDayStory(): ArtifactMoment[] {
	return [
		makeMoment({
			versionNumber: 4,
			kind: "alfy_edit",
			author: "alfy",
			text: "Added the rainy-day plan",
			fold: "undone",
			status: "undone",
			at: at(2026, 10, 11, 10, 12),
			containsNewest: true,
			detail: {
				type: "document",
				changed: { count: 0, first: null },
				added: { count: 1, first: "Rainy day" },
				removed: { count: 0, first: null },
				tab: null,
			},
			steps: [
				makeStep({
					versionNumber: 5,
					isNewest: true,
					at: at(2026, 10, 11, 10, 13),
				}),
			],
		}),
		makeMoment({
			versionNumber: 3,
			kind: "user_edit",
			author: "user",
			at: at(2026, 10, 11, 10, 9),
			startedAt: at(2026, 10, 11, 10, 3),
			detail: {
				type: "document",
				changed: { count: 3, first: "Saturday" },
				added: { count: 0, first: null },
				removed: { count: 0, first: null },
				tab: null,
			},
		}),
		makeMoment({
			versionNumber: 1,
			kind: "first_draft",
			author: "alfy",
			at: at(2026, 10, 11, 10, 0),
		}),
	];
}
