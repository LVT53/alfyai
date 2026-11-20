import { expect, it } from "vitest";
import type { memoryPublishedRows } from "$lib/server/db/schema";
import type { NativeMemory } from "./contracts";
import {
	matchOrdinaryMigrationCompanions,
	matchOrdinaryMigrationEvidence,
	matchPriorMigrationRepresentation,
} from "./migration-observation-proof";

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

it("permits ordinary coalescence only when original raw evidence remains represented", () => {
	expect(
		matchOrdinaryMigrationEvidence([ordinary, surviving], [raw, stable]),
	).toBe(true);
	expect(matchOrdinaryMigrationEvidence([ordinary], [raw])).toBe(false);
	expect(
		matchOrdinaryMigrationEvidence(
			[ordinary],
			[{ ...raw, mentioned_at: "2025-02-01" }, stable],
		),
	).toBe(false);
	expect(
		matchOrdinaryMigrationEvidence(
			[{ ...ordinary, sourceFingerprintsJson: "[]" }],
			[raw, stable],
		),
	).toBe(false);
});

it("requires every original fact after a derived observation splits", () => {
	const otherRaw = { ...raw, id: "b", text: "Other independent raw fact" };
	const combined = {
		...ordinary,
		sourceFingerprintsJson: JSON.stringify([
			{ id: "a", text: raw.text, mentionedAt: raw.mentioned_at },
			{ id: "b", text: otherRaw.text, mentionedAt: otherRaw.mentioned_at },
		]),
	};
	const additional = { ...successor, source_memory_ids: ["b"] };
	expect(
		matchOrdinaryMigrationEvidence(
			[combined],
			[raw, otherRaw, stable, additional],
		),
	).toBe(true);
	expect(
		matchOrdinaryMigrationEvidence([combined], [raw, otherRaw, stable]),
	).toBe(false);
});

it("preserves the exact already-published companion under an unlocated Remove", () => {
	const prior = [ordinary, surviving];
	expect(
		matchOrdinaryMigrationCompanions(prior, [], [raw, stable])?.exact,
	).toEqual([surviving]);
	expect(
		matchOrdinaryMigrationCompanions(prior, [ordinary], [raw, stable]),
	).toBeNull();
	expect(
		matchOrdinaryMigrationCompanions(prior, [], [raw, successor]),
	).toBeNull();
	expect(
		matchOrdinaryMigrationCompanions(prior, [], [raw, stable, successor]),
	).toBeNull();
	expect(
		matchOrdinaryMigrationCompanions(
			prior,
			[],
			[raw, { ...stable, id: "new-id" }],
		),
	).toBeNull();
	const other = { ...stable, id: "other" };
	expect(
		matchOrdinaryMigrationCompanions([surviving], [], [raw, stable, other]),
	).toBeNull();
	const newRaw = { ...raw, id: "n" };
	const newObservation = { ...stable, id: "new-obs", source_memory_ids: ["n"] };
	expect(
		matchOrdinaryMigrationCompanions(
			prior,
			[],
			[raw, stable, newRaw, newObservation],
		)?.exact,
	).toEqual([surviving]);
});

it("reconnects each exact independent observation and pins approved authored text to unique native evidence", async () => {
	const { reconnectVerifiedObservations } = await import(
		"./migration-observation-proof"
	);
	const authored = {
		...surviving,
		sourceFingerprintsJson: JSON.stringify([
			{
				id: "b",
				text: "Approved raw",
				mentionedAt: raw.mentioned_at,
				assertedAtMs: 2,
			},
		]),
	};
	const approved = new Map([[authored.nativeId, "Exact human wording"]]);
	const b = { ...raw, id: "b", text: "Approved raw" };
	const independent = {
		...stable,
		id: "renumbered-independent",
		text: ordinary.nativeText,
	};
	const reviewed = {
		...successor,
		id: "renumbered-authored",
		source_memory_ids: ["b"],
	};
	const live = [raw, b, independent, reviewed];
	expect(
		reconnectVerifiedObservations([ordinary, authored], live, approved),
	).toEqual(
		new Map([
			[independent.id, ordinary.text],
			[reviewed.id, "Exact human wording"],
		]),
	);
	expect(
		reconnectVerifiedObservations(
			[ordinary, authored],
			[...live, { ...reviewed, id: "ambiguous" }],
			approved,
		),
	).toBeNull();
	expect(
		reconnectVerifiedObservations(
			[ordinary, authored],
			[raw, { ...b, mentioned_at: "2025-05-01" }, independent, reviewed],
			approved,
		),
	).toBeNull();
	expect(
		reconnectVerifiedObservations(
			[ordinary, authored],
			[raw, b, { ...independent, text: "Changed assertion" }, reviewed],
			approved,
		),
	).toBeNull();
});
