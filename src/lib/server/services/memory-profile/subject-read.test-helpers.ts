import { eq } from "drizzle-orm";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";

/** One synthetic published entry with a single supporting fact from a source of its own. */
export interface SyntheticEntry {
	id: string;
	text: string;
	/** When its source was said (ISO or date). */
	said: string;
	kind: MemoryKind | null;
	subject: MemorySubject | null;
	/** Hindsight's text with its notes; the published text when absent. */
	nativeText?: string;
	/** `manual:` for an entry the person wrote. */
	eventId?: string;
}

/**
 * Publishes synthetic entries into a scope's bank (created when missing) for
 * the subject read model and the Overview's tests: one accepted source, one
 * fact, one published row and its label row per entry, in one transaction,
 * so a 5,000-entry bank takes moments. Never real data.
 */
export async function seedSubjectEntries(
	userId: string,
	scope: MemoryScope,
	entries: readonly SyntheticEntry[],
	options: { generation?: string } = {},
) {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const { ensureMemoryBank, memoryTextHash } = await import("./revisions");
	const bank = ensureMemoryBank(userId, scope);
	const generation = options.generation ?? "g";
	db.transaction((tx) => {
		tx.update(s.memoryAccounts)
			.set({ authority: "hindsight" })
			.where(eq(s.memoryAccounts.userId, userId))
			.run();
		tx.update(s.memoryBanks)
			.set({ generation })
			.where(eq(s.memoryBanks.id, bank.id))
			.run();
		for (const entry of entries) {
			const fact = { id: `f-${entry.id}`, text: `Synthetic fact ${entry.id}` };
			const source = `s-${bank.id}-${entry.id}`;
			const sourceText = `Synthetic source ${entry.id}`;
			tx.insert(s.memorySourceRevisions)
				.values({
					id: source,
					bankId: bank.id,
					userId,
					epoch: bank.epoch,
					eventId: entry.eventId ?? `message:${bank.id}:${entry.id}`,
					lineageId: `lineage-${entry.id}`,
					text: sourceText,
					context: "",
					textHash: memoryTextHash(sourceText),
					assertedAt: new Date(entry.said),
					acknowledgedFactsJson: JSON.stringify([fact]),
					state: "accepted",
				})
				.run();
			tx.insert(s.memoryPublishedRows)
				.values({
					id: `r-${bank.id}-${entry.id}`,
					nativeId: `n-${entry.id}`,
					bankId: bank.id,
					generation,
					epoch: bank.epoch,
					text: entry.text,
					nativeText: entry.nativeText ?? entry.text,
					sourceIdsJson: JSON.stringify([fact.id]),
					sourceFingerprintsJson: JSON.stringify([fact]),
					updatedAt: new Date(entry.said),
				})
				.run();
			if (entry.kind || entry.subject)
				tx.insert(s.memoryFactLabels)
					.values({
						bankId: bank.id,
						nativeFactId: fact.id,
						kind: entry.kind,
						subject: entry.subject,
						origin: "classifier",
						updatedAt: new Date(),
					})
					.run();
		}
	});
	return bank;
}
