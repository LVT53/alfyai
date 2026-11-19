import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryDeliveryJobs,
	memoryQuarantineDrafts,
} from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import { NativeMemoryError } from "./contracts";
import { inspectMemoryMigration } from "./migration-progress";
import {
	eligibleQuarantineSource,
	knownQuarantineWithdrawal,
	normalizeQuarantineText,
	quarantineSessionFor,
} from "./quarantine-policy";
import {
	assertMemoryBankFence,
	memoryScopeKey,
	memoryTextHash,
} from "./revisions";

type Context = JobRunContext<typeof memoryDeliveryJobs>;

type DraftExtractor = (
	input: { content: string; timestamp: string },
	beforeDispatch: () => void,
) => Promise<Array<{ text: string }>>;

export async function runMemoryQuarantineExtraction(
	ctx: Context,
	extract: DraftExtractor,
) {
	const verify = (tx: Tx, status: "running" | "succeeded" = "running") => {
		const { row } = ctx;
		const claim = tx
			.select({
				status: memoryDeliveryJobs.status,
				attempt: memoryDeliveryJobs.currentAttemptId,
			})
			.from(memoryDeliveryJobs)
			.where(eq(memoryDeliveryJobs.id, row.id))
			.get();
		if (
			ctx.signal.aborted ||
			claim?.status !== status ||
			claim.attempt !== ctx.attempt.id
		)
			return;
		const active = quarantineSessionFor(tx, row.userId);
		if (
			!active?.session.startRequestId ||
			active.session.epoch !== row.epoch ||
			active.session.controlRevision !== row.controlRevision ||
			row.requestId !==
				`quarantine:${active.session.startRequestId}:${row.sourceId}`
		)
			return;
		assertMemoryBankFence(tx, row.userId, row.bankId, row.epoch);
		const source = active.cohort.find(({ id }) => id === row.sourceId);
		if (!source) return;
		const inventory = inspectMemoryMigration(row.userId);
		const message = eligibleQuarantineSource(tx, active, source, inventory);
		return message
			? { source, message, inventory, frozenInventory: active.inventory }
			: undefined;
	};
	const initial = db.transaction((tx) => verify(tx));
	if (!initial) {
		await ctx.succeed();
		return;
	}
	const beforeDispatch = () => {
		ctx.signal.throwIfAborted();
		if (!db.transaction((tx) => verify(tx)))
			throw new NativeMemoryError("memory_source_control_changed", false);
	};
	const facts = await extract(
		{ content: initial.message.content, timestamp: initial.source.assertedAt },
		beforeDispatch,
	);
	if (facts.length > 64)
		throw new NativeMemoryError("memory_edit_too_large", false);
	await ctx.succeed({
		apply: (tx) => {
			const current = verify(tx, "succeeded");
			if (!current) return;
			for (const [ordinal, { text }] of facts.entries()) {
				if (
					knownQuarantineWithdrawal(current.inventory, initial.source, text) ||
					knownQuarantineWithdrawal(
						current.frozenInventory,
						initial.source,
						text,
					)
				)
					continue;
				if (!text.trim() || Buffer.byteLength(text) > 2048)
					throw new NativeMemoryError("memory_edit_invalid", false);
				tx.insert(memoryQuarantineDrafts)
					.values({
						id: randomUUID(),
						userId: ctx.row.userId,
						messageId: initial.source.id,
						ordinal,
						text,
						scopeKey: memoryScopeKey(initial.source.scope),
						textHash: memoryTextHash(normalizeQuarantineText(text)),
						assertedAt: new Date(initial.source.assertedAt),
					})
					.onConflictDoNothing()
					.run();
			}
		},
	});
}
