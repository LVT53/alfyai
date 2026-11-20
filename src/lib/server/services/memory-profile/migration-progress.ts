import { and, eq } from "drizzle-orm";
import type { MemoryScope } from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryControlIntervals,
	memoryDeliveryJobs,
	memoryMigrationManifests,
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryResetGenerations,
	memoryReviewItems,
	memoryReviewResolutions,
	memorySourceRevisions,
	messages,
	projects,
	users,
} from "$lib/server/db/schema";
import { nativeCurationForMigration } from "./curation-lineage";
import {
	historicalMemoryExclusion,
	usesDefaultHistoricalMemory,
} from "./history-eligibility";
import { parseJsonRecord } from "./internal-json";
import { knownQuarantineWithdrawal } from "./quarantine-policy";
import { memoryScopeKey, memoryTextHash } from "./revisions";
import { memoryScopeAt, readMemoryScopeMoves } from "./scope-history";
import { parseMemoryItemMetadata } from "./types";

/** Restricted persisted inventory: never serialize this structure to public logs. */
interface MigrationSource {
	id: string;
	conversationId: string | null;
	scope: MemoryScope;
	text: string;
	assertedAt: string;
	explicitEditAt?: string;
	messageAt?: string;
	eligibility: "eligible" | "uncertain" | "excluded" | "held";
	reason: string | null;
	lineageId: string;
	replayActionIds?: string[];
	defaultHistory?: true;
}
interface MigrationAction {
	id: string;
	kind: "remove" | "edit" | "authored" | "endorsement";
	before: string;
	after: string;
	at: string | null;
	sourceIds: string[];
	scope: MemoryScope | null;
	itemId?: string;
	reviewResolutionId?: string;
}
const REVIEW_CURRENT_SUPPORT_MISSING = "review_current_support_missing";
interface MigrationInventory {
	version: 1;
	userId: string;
	fingerprint: string;
	epoch: number;
	controlRevision: number;
	sources: MigrationSource[];
	actions: MigrationAction[];
	exceptions: Array<{ id: string; reason: string; sourceIds: string[] }>;
	holdHistory: boolean;
}
function array(value: string): unknown[] {
	try {
		const x: unknown = JSON.parse(value);
		return Array.isArray(x) ? x : [];
	} catch {
		return [];
	}
}
function strings(value: string): string[] {
	return array(value).filter((x): x is string => typeof x === "string");
}
function date(value: Date | null): string | null {
	return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
function records(userId: string) {
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw Error("memory_unauthorized");
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	const chats = db
		.select()
		.from(conversations)
		.where(eq(conversations.userId, userId))
		.all();
	const msgs = db
		.select({ message: messages, chat: conversations })
		.from(messages)
		.innerJoin(conversations, eq(messages.conversationId, conversations.id))
		.where(eq(conversations.userId, userId))
		.all();
	const items = db
		.select()
		.from(memoryProfileItems)
		.where(eq(memoryProfileItems.userId, userId))
		.all();
	const provenance = db
		.select()
		.from(memoryProfileItemProvenance)
		.where(eq(memoryProfileItemProvenance.userId, userId))
		.all();
	const reviews = db
		.select()
		.from(memoryReviewItems)
		.where(eq(memoryReviewItems.userId, userId))
		.all();
	const resolutions = db
		.select()
		.from(memoryReviewResolutions)
		.where(eq(memoryReviewResolutions.userId, userId))
		.all();
	const intervals = db
		.select()
		.from(memoryControlIntervals)
		.where(eq(memoryControlIntervals.userId, userId))
		.all();
	const reset = db
		.select()
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, userId))
		.get();
	return {
		user,
		account,
		chats,
		msgs,
		items,
		provenance,
		reviews,
		resolutions,
		intervals,
		reset,
	};
}
/** No account creation, source writes, model calls, or implicit historical permission. */
export function inspectMemoryMigration(userId: string): MigrationInventory {
	return db.transaction((tx) => {
		const r = records(userId);
		const epoch = r.account?.epoch ?? 0;
		const result: MigrationInventory = {
			version: 1,
			userId,
			epoch,
			controlRevision: r.account?.controlRevision ?? 0,
			fingerprint: "",
			sources: [],
			actions: [],
			exceptions: [],
			holdHistory: false,
		};
		// Include all mutable legacy source/action/privacy state. Authority/history progress are intentionally omitted.
		result.fingerprint = memoryTextHash(
			JSON.stringify({
				enabled: r.user.memoryEnabled,
				epoch,
				controlRevision: result.controlRevision,
				choice: r.account?.historyChoice,
				cutoff: r.account?.historyCutoff,
				policy: r.account?.historyPolicyVersion,
				chats: r.chats,
				msgs: r.msgs,
				items: r.items,
				provenance: r.provenance,
				reviews: r.reviews,
				resolutions: r.resolutions,
				intervals: r.intervals,
				reset: r.reset,
			}),
		);
		const controls = {
			account: r.account,
			intervals: r.intervals,
			enabled: r.user.memoryEnabled,
			resetAt: r.reset?.advancedAt,
		};
		const curation = nativeCurationForMigration(tx, userId, epoch);
		for (const { message: m, chat } of r.msgs) {
			if (m.role !== "user") continue;
			const meta = parseJsonRecord(m.metadataJson);
			const revision = curation.revision({
				messageId: m.id,
				conversationId: chat.id,
				textHash: memoryTextHash(m.content),
				assertedAt: m.createdAt,
			});
			const at = date(revision?.assertedAt ?? m.createdAt);
			const permissionAt =
				revision?.explicitEditAt ?? revision?.assertedAt ?? m.createdAt;
			const reason = m.importSource
				? "imported_message"
				: meta.forkCopy
					? "fork_copy"
					: historicalMemoryExclusion(controls, {
							assertedAt: permissionAt,
							incognito: chat.memoryIncognito,
						});
			result.sources.push({
				id: m.id,
				conversationId: chat.id,
				scope: chat.projectId
					? { kind: "project", projectId: chat.projectId }
					: { kind: "personal" },
				text: m.content,
				assertedAt: at ?? "",
				explicitEditAt: date(revision?.explicitEditAt ?? null) ?? undefined,
				messageAt: date(m.createdAt) ?? undefined,
				lineageId: revision?.lineageId ?? m.id,
				eligibility:
					reason === "unknown_history"
						? "uncertain"
						: reason
							? "excluded"
							: "eligible",
				reason,
				...(!reason && usesDefaultHistoricalMemory(controls, permissionAt)
					? { defaultHistory: true as const }
					: {}),
			});
		}
		const previous = latestManifest(userId);
		if (previous?.epoch === epoch) {
			const saved: MigrationInventory = JSON.parse(previous.manifestJson);
			for (const source of result.sources) {
				const old = saved.sources.find((s) => s.id === source.id);
				if (
					old &&
					(old.text !== source.text ||
						saved.exceptions.some((e) => e.id === `source-edit:${source.id}`))
				) {
					result.exceptions.push({
						id: `source-edit:${source.id}`,
						reason: "unknown_source_edit_date",
						sourceIds: [source.id],
					});
					if (source.eligibility === "eligible") {
						source.eligibility = "held";
						source.reason = "unknown_source_edit_date";
					}
				}
			}
		}
		const resetGeneration = r.reset?.resetGeneration ?? 0;
		const itemById = new Map(r.items.map((i) => [i.id, i]));
		const sourceById = new Map(result.sources.map((s) => [s.id, s]));
		// Resolve explicit IDs only, including item/provenance indirection and whole-chat boundaries.
		function resolve(id: string, seen = new Set<string>()): string[] {
			if (seen.has(id)) return [];
			seen.add(id);
			if (sourceById.has(id)) {
				const message = r.msgs.find((x) => x.message.id === id)?.message;
				const fork = message
					? parseJsonRecord(message.metadataJson).forkCopy
					: null;
				if (
					fork &&
					typeof fork === "object" &&
					"sourceMessageId" in fork &&
					typeof fork.sourceMessageId === "string"
				)
					return resolve(fork.sourceMessageId, seen);
				return [id];
			}
			if (r.chats.some((c) => c.id === id))
				return result.sources
					.filter((s) => s.conversationId === id)
					.map((s) => s.id);
			const links = r.provenance.filter((p) => p.itemId === id || p.id === id);
			return [
				...new Set(
					links.flatMap((p) => {
						const metadata = parseJsonRecord(p.metadataJson);
						const ids = [
							p.sourceId,
							metadata.messageId,
							metadata.sourceMessageId,
							metadata.conversationId,
						].filter((v): v is string => typeof v === "string");
						return ids.flatMap((v) => resolve(v, new Set(seen)));
					}),
				),
			];
		}
		function knownItemBoundary(id: string): boolean {
			return r.provenance.some(
				(p) =>
					p.itemId === id &&
					p.sourceId &&
					["conversation", "message"].includes(p.sourceType),
			);
		}
		const scopeMoves = readMemoryScopeMoves(tx, userId, epoch);
		function scope(
			type: string,
			id: string,
			authoredAt?: Date,
		): MemoryScope | null {
			if (type === "global") return { kind: "personal" };
			if (type === "project") return { kind: "project", projectId: id };
			if (type === "conversation") {
				const c = r.chats.find((c) => c.id === id);
				if (!c || c.memoryIncognito) return null;
				const current = c.projectId ? `project:${c.projectId}` : "personal";
				const key = authoredAt
					? memoryScopeAt(scopeMoves.get(c.id) ?? [], current, authoredAt)
					: current;
				if (key === "personal") return { kind: "personal" };
				if (!key?.startsWith("project:")) return null;
				const projectId = key.slice(8);
				return tx
					.select({ id: projects.id })
					.from(projects)
					.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
					.get()
					? { kind: "project", projectId }
					: null;
			}
			return null;
		}
		function addAction(
			action: MigrationAction,
			reason?: string,
			knownBoundary = false,
		) {
			const bounded = knownBoundary || action.sourceIds.length > 0;
			if (action.at)
				action.sourceIds = action.sourceIds.filter((id) => {
					const source = sourceById.get(id);
					return (
						!source ||
						(source.explicitEditAt ?? source.assertedAt) <= (action.at ?? "")
					);
				});
			result.actions.push(action);
			if (action.kind === "endorsement") return;
			if (
				reason ||
				!action.at ||
				(!action.sourceIds.length && action.kind !== "authored" && !bounded)
			) {
				result.exceptions.push({
					id: action.id,
					reason:
						reason ??
						(!action.at ? "unknown_action_date" : "unknown_exclusion_boundary"),
					sourceIds: action.sourceIds,
				});
				if (!action.sourceIds.length && action.kind !== "authored" && !bounded)
					result.holdHistory = true;
				for (const id of action.sourceIds) {
					const s = sourceById.get(id);
					if (s?.eligibility === "eligible") {
						s.eligibility = "held";
						s.reason = reason ?? "unresolved_action";
					}
				}
			}
		}
		for (const item of r.items.filter(
			(i) => i.resetGeneration === resetGeneration,
		)) {
			const metadata = parseMemoryItemMetadata(item.metadataJson);
			const ids = resolve(item.id);
			const itemScope = scope(
				item.scopeType,
				item.scopeId,
				metadata.origin === "user_authored" ? item.updatedAt : undefined,
			);
			if (
				(item.status === "deleted" || item.status === "suppressed") &&
				metadata.origin === "user_authored" &&
				(metadata.reviewResolution === "edited" ||
					!r.provenance.some((p) => p.itemId === item.id))
			) {
				// A review replacement inherits the original item's provenance for
				// navigation. The removed authored text is a separate source.
				result.actions.push({
					id: `standalone-removed:${item.id}`,
					kind: "remove",
					before: item.statement,
					after: "",
					at: date(item.deletedAt ?? item.suppressedAt),
					sourceIds: [],
					scope: itemScope,
				});
			} else if (item.status === "deleted" || item.status === "suppressed")
				addAction(
					{
						id: `item:${item.id}:${item.revision}:${date(item.deletedAt ?? item.suppressedAt)}`,
						kind: "remove",
						before: item.statement,
						after: "",
						at: date(item.deletedAt ?? item.suppressedAt),
						sourceIds: ids,
						scope: itemScope,
					},
					!ids.length && knownItemBoundary(item.id)
						? "missing_source"
						: undefined,
					knownItemBoundary(item.id),
				);
			else if (
				metadata.origin === "user_authored" &&
				item.status === "active"
			) {
				if (ids.length && metadata.reviewResolution !== "edited") {
					result.exceptions.push({
						id: `authored-predecessor:${item.id}`,
						reason: "missing_pre_edit_statement",
						sourceIds: ids,
					});
					for (const id of ids) {
						const source = sourceById.get(id);
						if (source?.eligibility === "eligible") {
							source.eligibility = "held";
							source.reason = "missing_pre_edit_statement";
						}
					}
				}
				// The legacy writer protects authored rows. updatedAt is the persisted user edit time, never import time.
				addAction(
					{
						id: `authored:${item.id}:${item.revision}`,
						kind: "authored",
						before: "",
						after: item.statement,
						at: date(item.updatedAt),
						sourceIds: ids,
						scope: itemScope,
						itemId: item.id,
					},
					itemScope ? undefined : "unknown_scope",
				);
			} else if (metadata.endorsement === "user_accepted")
				addAction({
					id: `endorsement:${item.id}`,
					kind: "endorsement",
					before: item.statement,
					after: item.statement,
					at:
						typeof metadata.userConfirmedAt === "string"
							? metadata.userConfirmedAt
							: null,
					sourceIds: ids,
					scope: itemScope,
				});
		}
		function matchesReviewScope(
			item: (typeof r.items)[number],
			authoredScope: MemoryScope,
		) {
			const currentScope = scope(item.scopeType, item.scopeId);
			return (
				currentScope !== null &&
				memoryScopeKey(currentScope) === memoryScopeKey(authoredScope)
			);
		}
		const reviewEditsWithoutCurrentSupport: MigrationInventory["exceptions"] =
			[];
		const now = Date.now();
		for (const resolution of r.resolutions.filter(
			(x) => x.resetGeneration === resetGeneration,
		)) {
			const resolutionMetadata = parseJsonRecord(resolution.metadataJson);
			if (
				resolution.resolutionType === "do_not_remember" &&
				(resolutionMetadata.reason === "review_item_expired" ||
					resolutionMetadata.reason === "review_item_no_longer_pending")
			)
				continue;
			const review = r.reviews.find((x) => x.id === resolution.reviewItemId);
			if (!review) continue;
			const affected = strings(review.affectedItemIdsJson);
			const ids = [
				...new Set([
					...affected.flatMap((id) => resolve(id)),
					...array(review.evidenceJson).flatMap((e) => {
						if (!e || typeof e !== "object") return [];
						const v = e as Record<string, unknown>;
						return [v.sourceId, v.messageId, v.conversationId]
							.filter((x): x is string => typeof x === "string")
							.flatMap((x) => resolve(x));
					}),
				]),
			];
			const replacementIds = new Set(
				[
					resolutionMetadata.replacementItemId,
					...affected.flatMap((id) => {
						const item = itemById.get(id);
						const predecessor = parseMemoryItemMetadata(item?.metadataJson);
						if (predecessor.retiredReason === "review_edited")
							return [predecessor.supersededBy];
						// A same-key edit can update the affected item in place. Older
						// rows have no replacementItemId for that transition.
						return predecessor.origin === "user_authored" &&
							predecessor.reviewResolution === "edited"
							? [id]
							: [];
					}),
				].filter((id): id is string => typeof id === "string"),
			);
			const unresolvedReplacement =
				resolution.resolutionType === "edit_fact" &&
				[...replacementIds].some((id) => {
					const replacement = itemById.get(id);
					return (
						!replacement ||
						replacement.resetGeneration !== resetGeneration ||
						parseMemoryItemMetadata(replacement.metadataJson).origin !==
							"user_authored"
					);
				});
			if (
				resolution.resolutionType === "edit_fact" &&
				resolution.editedStatement?.trim() &&
				replacementIds.size === 0
			) {
				// Older review-only records can contain the only saved authored text.
				// If a replacement is recorded, its current item is authoritative.
				const item = affected.map((id) => itemById.get(id)).find(Boolean);
				const authoredScope = item
					? scope(item.scopeType, item.scopeId, resolution.createdAt)
					: null;
				if (
					authoredScope &&
					!r.items.some(
						(current) =>
							current.resetGeneration === resetGeneration &&
							current.status === "active" &&
							!current.deletedAt &&
							!current.suppressedAt &&
							(!current.expiresAt || current.expiresAt.getTime() > now) &&
							current.statement === resolution.editedStatement &&
							matchesReviewScope(current, authoredScope),
					)
				) {
					reviewEditsWithoutCurrentSupport.push({
						id: `authored:review:${resolution.id}`,
						reason: REVIEW_CURRENT_SUPPORT_MISSING,
						sourceIds: ids,
					});
				}
				addAction(
					{
						id: `authored:review:${resolution.id}`,
						kind: "authored",
						before: "",
						after: resolution.editedStatement,
						at: date(resolution.createdAt),
						sourceIds: ids,
						scope: authoredScope,
						reviewResolutionId: resolution.id,
					},
					authoredScope ? undefined : "unknown_scope",
				);
			}
			if (
				resolution.resolutionType === "do_not_remember" ||
				resolution.resolutionType === "edit_fact"
			) {
				const statements = affected.map((id) => {
					const item = itemById.get(id);
					if (item && item.updatedAt <= resolution.createdAt)
						return item.statement;
					const evidence = array(review.evidenceJson).find(
						(e) =>
							e && typeof e === "object" && "itemId" in e && e.itemId === id,
					);
					return evidence &&
						typeof evidence === "object" &&
						"statement" in evidence &&
						typeof evidence.statement === "string"
						? evidence.statement
						: null;
				});
				const before = statements.filter(Boolean).join("\n");
				addAction(
					{
						id: `review:${resolution.id}`,
						kind: resolution.resolutionType === "edit_fact" ? "edit" : "remove",
						before,
						after: resolution.editedStatement ?? "",
						at: date(resolution.createdAt),
						sourceIds: ids,
						scope: null,
					},
					unresolvedReplacement
						? "missing_review_replacement"
						: before && statements.every(Boolean)
							? !ids.length && affected.some(knownItemBoundary)
								? "missing_source"
								: undefined
							: "missing_removed_statement",
					affected.some(knownItemBoundary),
				);
			}
		}
		// Under an unresolved withdrawal boundary, a review-only assertion is
		// historical evidence. It needs current support before import.
		if (result.holdHistory)
			result.exceptions.push(...reviewEditsWithoutCurrentSupport);
		const historyBoundary = latestManifest(userId)?.createdAt ?? new Date();
		if (result.holdHistory)
			for (const s of result.sources)
				if (
					s.eligibility === "eligible" &&
					new Date(s.explicitEditAt ?? s.assertedAt) <= historyBoundary
				) {
					s.eligibility = "held";
					s.reason = "unknown_exclusion_boundary";
				}
		for (const source of result.sources) {
			if (source.eligibility !== "eligible") continue;
			if (source.defaultHistory) {
				const scopeKey = memoryScopeKey(source.scope);
				const origin = memoryScopeAt(
					scopeMoves.get(source.conversationId) ?? [],
					scopeKey,
					new Date(source.messageAt ?? source.assertedAt),
				);
				if (origin !== scopeKey) {
					source.eligibility = "held";
					source.reason = "historical_scope_changed";
					result.exceptions.push({
						id: `historical-scope:${source.id}`,
						reason: source.reason,
						sourceIds: [source.id],
					});
					continue;
				}
				if (knownQuarantineWithdrawal(result, source, source.text)) {
					source.eligibility = "excluded";
					source.reason = "known_withdrawal";
					continue;
				}
			}
			const plan = curation.plan(
				{
					userId,
					epoch,
					conversationId: source.conversationId,
					messageId: source.id,
					lineageId: source.lineageId,
					textHash: memoryTextHash(source.text),
					assertedAt: new Date(source.assertedAt),
					explicitEditAt: source.explicitEditAt
						? new Date(source.explicitEditAt)
						: null,
				},
				memoryScopeKey(source.scope),
				new Date(source.messageAt ?? source.assertedAt),
			);
			if (plan.blocked) {
				source.eligibility = "held";
				source.reason = "native_curation_scope_unresolved";
				result.exceptions.push({
					id: `native-curation:${source.id}`,
					reason: source.reason,
					sourceIds: [source.id],
				});
			} else if (plan.ids.length) {
				if (source.defaultHistory) {
					source.eligibility = "excluded";
					source.reason = "known_withdrawal";
				} else source.replayActionIds = plan.ids;
			}
		}
		result.sources.sort(
			(a, b) =>
				(a.explicitEditAt ?? a.assertedAt).localeCompare(
					b.explicitEditAt ?? b.assertedAt,
				) || a.id.localeCompare(b.id),
		);
		result.actions.sort(
			(a, b) =>
				(a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id),
		);
		return result;
	});
}

export function latestManifest(userId: string) {
	return db
		.select()
		.from(memoryMigrationManifests)
		.where(eq(memoryMigrationManifests.userId, userId))
		.all()
		.sort(
			(a, b) =>
				b.epoch - a.epoch || b.createdAt.getTime() - a.createdAt.getTime(),
		)[0];
}
function currentMigrationJobs(
	jobs: (typeof memoryDeliveryJobs.$inferSelect)[],
	checkpoint: Record<string, unknown>,
	sources: (typeof memorySourceRevisions.$inferSelect)[] = [],
) {
	const required = Array.isArray(checkpoint.requestIds)
		? new Set(checkpoint.requestIds)
		: null;
	const scopeCleanup = new Set(
		jobs
			.filter(
				(job) =>
					job.kind === "source_cleanup" &&
					job.requestId.startsWith("scope-move-cleanup:"),
			)
			.map((job) => job.sourceId),
	);
	const cleanedSources = new Set(
		jobs
			.filter(
				(job) => job.kind === "source_cleanup" && job.status === "succeeded",
			)
			.map((job) => job.sourceId),
	);
	return jobs.filter((job) => {
		if (job.kind === "quarantine_extract") return false;
		if (job.kind === "cleanup") return true;
		if (job.kind === "source_cleanup") {
			if (scopeCleanup.has(job.sourceId))
				return job.requestId.startsWith("scope-move-cleanup:");
			return job.status === "succeeded" || !cleanedSources.has(job.sourceId);
		}
		if (required) return required.has(job.requestId);
		// Older checkpoints relied on source rows instead of request IDs.
		return (
			job.kind !== "source" ||
			!sources.length ||
			sources.some(
				(source) => source.id === job.sourceId && source.state !== "revoked",
			)
		);
	});
}
export function verifyMemoryMigration(userId: string, id: string) {
	return db.transaction(() => {
		const manifest = db
			.select()
			.from(memoryMigrationManifests)
			.where(
				and(
					eq(memoryMigrationManifests.id, id),
					eq(memoryMigrationManifests.userId, userId),
				),
			)
			.get();
		if (!manifest) throw Error("memory_migration_missing");
		const inventory = inspectMemoryMigration(userId);
		const saved: MigrationInventory = JSON.parse(manifest.manifestJson);
		const jobs = db
			.select()
			.from(memoryDeliveryJobs)
			.where(
				and(
					eq(memoryDeliveryJobs.userId, userId),
					eq(memoryDeliveryJobs.epoch, inventory.epoch),
				),
			)
			.all();
		const sources = db
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.epoch, inventory.epoch),
				),
			)
			.all();
		const unsupportedReviewEdits = (entry: MigrationInventory) =>
			entry.exceptions
				.filter(({ reason }) => reason === REVIEW_CURRENT_SUPPORT_MISSING)
				.map(({ id }) => id)
				.sort();
		const changed =
			saved.fingerprint !== inventory.fingerprint ||
			manifest.epoch !== inventory.epoch ||
			JSON.stringify(unsupportedReviewEdits(saved)) !==
				JSON.stringify(unsupportedReviewEdits(inventory)) ||
			saved.sources.some(
				(source, i) =>
					source.eligibility !== inventory.sources[i]?.eligibility ||
					JSON.stringify(source.replayActionIds ?? []) !==
						JSON.stringify(inventory.sources[i]?.replayActionIds ?? []),
			);
		const checkpoint = parseJsonRecord(manifest.checkpointJson);
		const required = Array.isArray(checkpoint.sourceIds)
			? checkpoint.sourceIds
			: null;
		const requestIds = Array.isArray(checkpoint.requestIds)
			? new Set(checkpoint.requestIds)
			: null;
		const current = currentMigrationJobs(jobs, checkpoint, sources);
		const knownRequests = new Set(jobs.map((job) => job.requestId));
		const missing = requestIds
			? [...requestIds].filter((id) => !knownRequests.has(id)).length
			: 0;
		const pending =
			current.filter((job) => job.status !== "succeeded").length + missing;
		const failed =
			current.filter(
				(job) => job.status === "failed" || job.status === "cancelled",
			).length + missing;
		const accounted =
			required?.every(
				(id) =>
					typeof id === "string" &&
					sources.some((s) => s.id === id && s.state === "accepted"),
			) ?? false;
		const ready = accounted && !changed && !pending;
		return {
			ready,
			changed,
			pending,
			failed,
			held: inventory.exceptions.length,
			uncertain: inventory.sources.filter((s) => s.eligibility === "uncertain")
				.length,
			sourceCount: sources.length,
		};
	});
}
/** Called by the existing worker after terminal progress, never a second scheduler. */
export function settleMemoryMigration(userId: string): void {
	db.transaction((tx) => {
		const manifest = latestManifest(userId);
		if (!manifest) return;
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (
			!account ||
			account.epoch !== manifest.epoch ||
			account.authority === "legacy" ||
			account.lifecycleState !== "active"
		)
			return;
		const checkpoint = parseJsonRecord(manifest.checkpointJson);
		const jobs = tx
			.select()
			.from(memoryDeliveryJobs)
			.where(
				and(
					eq(memoryDeliveryJobs.userId, userId),
					eq(memoryDeliveryJobs.epoch, account.epoch),
				),
			)
			.all();
		if (
			currentMigrationJobs(jobs, checkpoint).some(
				(job) => job.status === "queued" || job.status === "running",
			)
		)
			return;
		const report = verifyMemoryMigration(userId, manifest.id);
		if (report.changed || (!report.ready && !report.failed)) return;
		tx.update(memoryMigrationManifests)
			.set({
				status: report.failed
					? "failed"
					: checkpoint.cutoverAt
						? "cutover"
						: "prepared",
			})
			.where(eq(memoryMigrationManifests.id, manifest.id))
			.run();
		tx.update(memoryAccounts)
			.set({
				historyStatus: report.failed
					? "failed"
					: report.held || report.uncertain
						? "held"
						: report.ready
							? "complete"
							: "working",
			})
			.where(eq(memoryAccounts.userId, userId))
			.run();
	});
}
