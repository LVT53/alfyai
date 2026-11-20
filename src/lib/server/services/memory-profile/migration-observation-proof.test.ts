import { expect, it } from "vitest";
import type { memoryPublishedRows } from "$lib/server/db/schema";
import type { NativeMemory } from "./contracts";
import { matchPriorMigrationRepresentation } from "./migration-observation-proof";

const ordinary: typeof memoryPublishedRows.$inferSelect = {
	id: "ordinary",
	bankId: "bank",
	epoch: 1,
	generation: "gen",
	nativeId: "old",
	text: "Prior wording",
	nativeText: "Prior wording",
	sourceIdsJson: '["a"]',
	sourceFingerprintsJson: JSON.stringify([
		{ id: "a", text: "Raw fact", mentionedAt: "2025-01-02", assertedAtMs: 1 },
	]),
	updatedAt: new Date(1),
};
const surviving = {
	...ordinary,
	id: "surviving",
	nativeId: "surviving",
	text: "Unchanged",
	nativeText: "Unchanged",
};
const raw: NativeMemory = {
	id: "a",
	text: "Raw fact",
	fact_type: "world",
	mentioned_at: "2025-01-02",
};
const stable: NativeMemory = {
	id: "surviving",
	text: "Unchanged",
	fact_type: "observation",
	source_memory_ids: ["a"],
};
const successor = { ...stable, id: "successor", text: "Regenerated wording" };

it("matches one ordinary renamed presentation without borrowing another exact observation", () => {
	const prior = [ordinary, surviving],
		live = [raw, stable, successor];
	expect(
		matchPriorMigrationRepresentation(prior, live, true, [surviving]),
	).toEqual({
		exact: [surviving],
		regenerated: { prior: ordinary, nativeId: "successor" },
	});
	expect(
		matchPriorMigrationRepresentation([ordinary], [raw, successor], true, []),
	).toBeNull();
	expect(
		matchPriorMigrationRepresentation(prior, live, true, [ordinary]),
	).toBeNull();
	expect(
		matchPriorMigrationRepresentation(prior, [raw, stable], true, []),
	).toBeNull();
	expect(
		matchPriorMigrationRepresentation(
			prior,
			[...live, { ...successor, id: "ambiguous" }],
			true,
			[],
		),
	).toBeNull();
	expect(
		matchPriorMigrationRepresentation(
			prior,
			[{ ...raw, mentioned_at: "2025-02-01" }, stable, successor],
			true,
			[],
		),
	).toBeNull();
	expect(
		matchPriorMigrationRepresentation(
			prior,
			[raw, stable, { ...successor, source_memory_ids: ["a", "foreign"] }],
			true,
			[],
		),
	).toBeNull();
});
