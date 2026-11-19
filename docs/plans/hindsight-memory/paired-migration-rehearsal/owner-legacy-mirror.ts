import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type * as schema from "../../../../src/lib/server/db/schema";

type Case = { id: string; projectId: string | null; query: string };
type Fact = Pick<
	typeof schema.memoryProfileItems.$inferInsert,
	"id" | "itemKey" | "category" | "scopeType" | "scopeId" | "statement"
> & { updatedAt: number };

function hold(): never {
	throw new Error("legacy_provenance_unavailable");
}

/**
 * Run in a dedicated process with a fresh private scratch DATABASE_PATH.
 * Freeze input and the factual checkpoint on the owner host. Never publish
 * this function's results or SQLite exceptions. No source content is selected.
 */
export async function readOwnerLegacyMirror(input: {
	databasePath: string;
	email: string;
	userId: string;
	cases: Case[];
}) {
	// Check before any source-side metadata is loaded. The application DB must be
	// a fresh mirror already bound by bootstrap, never the source DB.
	if (process.env.DATABASE_PATH !== ":memory:") hold();
	const { db, sqlite } = await import("../../../../src/lib/server/db");
	const schema = await import("../../../../src/lib/server/db/schema");
	const { historicalMemoryExclusion } = await import(
		"../../../../src/lib/server/services/memory-profile/history-eligibility"
	);
	const { getMemoryContext } = await import(
		"../../../../src/lib/server/services/memory-context"
	);
	const files = sqlite.pragma("database_list") as Array<{ file: string }>;
	if (files.some(({ file }) => file)) hold();
	if (
		sqlite
			.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
			.pluck()
			.get() !== 0
	)
		hold();
	const readSnapshot = () => {
		const source = new Database(input.databasePath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			source.pragma("query_only = ON");
			return source
				.transaction(() => {
					const users = source
						.prepare(`
				SELECT id, name, memory_enabled AS enabled FROM users
				WHERE email COLLATE BINARY = ? LIMIT 2
			`)
						.all(input.email) as Array<{
						id: string;
						name: string | null;
						enabled: number;
					}>;
					const user = users[0];
					if (
						users.length !== 1 ||
						!input.userId ||
						user.id !== input.userId ||
						user.enabled !== 1
					)
						hold();
					const uid = user.id;
					const account = source
						.prepare(`
				SELECT authority, lifecycle_state AS lifecycle,
				history_choice AS historyChoice, history_cutoff AS historyCutoff,
				history_policy_version AS historyPolicyVersion
				FROM memory_accounts WHERE user_id = ?
			`)
						.get(uid) as
						| {
								authority: string;
								lifecycle: string;
								historyChoice: string | null;
								historyCutoff: number | null;
								historyPolicyVersion: string;
						  }
						| undefined;
					if (
						account &&
						(account.authority !== "legacy" || account.lifecycle !== "active")
					)
						hold();
					const checkpoint = source
						.prepare(`
				SELECT reset_generation AS generation, advanced_at AS advancedAt
				FROM memory_reset_generations WHERE user_id = ?
			`)
						.get(uid) as
						| { generation: number; advancedAt: number | null }
						| undefined;
					const reset = checkpoint?.generation ?? 0;
					const ownsProject = source.prepare(
						"SELECT 1 FROM projects WHERE user_id = ? AND id = ?",
					);
					if (
						input.cases.some(
							(item) => item.projectId && !ownsProject.get(uid, item.projectId),
						)
					)
						hold();

					if (
						source
							.prepare(`
				SELECT 1 FROM memory_projection_state
				WHERE user_id = ? AND reset_generation = ? AND scope_type = 'global'
				AND scope_id = '' AND coalesce(persona_summary_text, '') <> ''
			`)
							.get(uid, reset)
					)
						hold();
					const active = `FROM memory_profile_items
				WHERE user_id = ? AND reset_generation = ? AND status = 'active'`;
					const identities = source
						.prepare(`SELECT id, scope_type AS scopeType, scope_id AS scopeId,
				expires_at AS expiresAt, suppressed_at AS suppressedAt, deleted_at AS deletedAt
				${active} ORDER BY updated_at DESC LIMIT 13`)
						.all(uid, reset) as Array<{
						id: string;
						scopeType: string;
						scopeId: string;
						expiresAt: number | null;
						suppressedAt: number | null;
						deletedAt: number | null;
					}>;
					if (!identities.length) return { user, reset, facts: [] };
					// Beyond 12 facts the authentic reader can use semantic shortlist.
					// Never emulate it on a partial mirror. Unsupported directives/edits
					// are held as a group rather than borrowing scope or guessing links.
					if (
						identities.length > 12 ||
						source
							.prepare(`
				SELECT 1 WHERE
				EXISTS (SELECT 1 FROM memory_actions WHERE user_id = ?)
				OR EXISTS (SELECT 1 FROM memory_review_resolutions WHERE user_id = ?)
				OR EXISTS (SELECT 1 FROM memory_profile_items WHERE user_id = ?
					AND reset_generation = ? AND status IN ('deleted', 'suppressed', 'retired'))
				OR EXISTS (SELECT 1 FROM memory_source_revisions WHERE user_id = ?)
				OR EXISTS (SELECT 1 FROM memory_migration_manifests WHERE user_id = ?)
				OR EXISTS (SELECT 1 FROM memory_revocations WHERE user_id = ?)
				OR EXISTS (SELECT 1 FROM memory_events WHERE user_id = ? AND event_type = 'memory_scope_moved')
			`)
							.get(uid, uid, uid, reset, uid, uid, uid, uid)
					)
						hold();

					const intervals = source
						.prepare(`
				SELECT started_at AS startedAt, ended_at AS endedAt, enabled
				FROM memory_control_intervals WHERE user_id = ?
			`)
						.all(uid) as Array<{
						startedAt: number;
						endedAt: number | null;
						enabled: number;
					}>;
					const asDate = (seconds: number | null | undefined) =>
						seconds == null ? null : new Date(seconds * 1000);
					const controls = {
						enabled: true,
						account: account && {
							...account,
							historyCutoff: asDate(account.historyCutoff),
						},
						resetAt: asDate(checkpoint?.advancedAt),
						intervals: intervals.map((period) => ({
							startedAt: new Date(period.startedAt * 1000),
							endedAt: asDate(period.endedAt),
							enabled: period.enabled === 1,
						})),
					};
					const authoredContext = source.prepare(`
				SELECT m.created_at AS assertedAt, m.import_source AS importSource,
					CASE WHEN m.metadata_json IS NULL THEN 1
					WHEN json_valid(m.metadata_json) THEN json(m.metadata_json) = '{}'
					ELSE 0 END AS plain
				FROM messages m JOIN conversations c ON c.id = m.conversation_id
				WHERE c.user_id = ? AND c.id = ? AND m.role = 'user'
			`);
					const checkedConversations = new Set<string>();
					const sourceReferences: string[] = [];
					const sources = source.prepare(`
				SELECT p.source_type AS sourceType, c.id AS sourceId,
					c.project_id AS projectId, c.memory_incognito AS incognito,
					m.id AS messageId, m.created_at AS assertedAt
				FROM memory_profile_item_provenance p
				JOIN memory_profile_items i ON i.id = p.item_id AND i.user_id = p.user_id
					AND i.reset_generation = p.reset_generation
				LEFT JOIN conversations c ON c.user_id = p.user_id AND c.id = p.source_id
				LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
					AND length(p.summary) > 0 AND instr(m.content, p.summary) > 0
					AND length(i.statement) > 0 AND instr(m.content, i.statement) > 0
					AND m.import_source IS NULL
					AND (m.metadata_json IS NULL OR
						CASE WHEN json_valid(m.metadata_json) THEN json(m.metadata_json) = '{}' ELSE 0 END)
				WHERE p.user_id = ? AND p.reset_generation = ? AND p.item_id = ?
			`);
					for (const item of identities) {
						if (
							item.expiresAt !== null ||
							item.deletedAt !== null ||
							item.suppressedAt !== null ||
							!(
								(item.scopeType === "global" && item.scopeId === "") ||
								(item.scopeType === "project" &&
									ownsProject.get(uid, item.scopeId))
							)
						)
							hold();
						const links = sources.all(uid, reset, item.id) as Array<{
							sourceType: string;
							sourceId: string | null;
							messageId: string | null;
							projectId: string | null;
							incognito: number;
							assertedAt: number | null;
						}>;
						if (
							!links.length ||
							links.some(
								(link) =>
									link.sourceType !== "conversation" ||
									!link.sourceId ||
									link.assertedAt === null ||
									link.projectId !==
										(item.scopeType === "project" ? item.scopeId : null) ||
									historicalMemoryExclusion(controls, {
										assertedAt: new Date(link.assertedAt * 1000),
										incognito: link.incognito !== 0,
									}) !== null,
							)
						)
							hold();
						for (const link of links) {
							sourceReferences.push(
								JSON.stringify([
									item.id,
									link.sourceId,
									link.messageId,
									link.assertedAt,
								]),
							);
							if (!link.sourceId || checkedConversations.has(link.sourceId))
								continue;
							const context = authoredContext.all(uid, link.sourceId) as Array<{
								assertedAt: number;
								importSource: string | null;
								plain: number;
							}>;
							if (
								context.some(
									(message) =>
										message.importSource !== null ||
										message.plain !== 1 ||
										historicalMemoryExclusion(controls, {
											assertedAt: new Date(message.assertedAt * 1000),
										}) !== null,
								)
							)
								hold();
							checkedConversations.add(link.sourceId);
						}
					}
					// Only now load eligible statements. Read no source messages, quotes,
					// credentials, summaries or unrelated account values into the mirror.
					const facts = source
						.prepare(`SELECT id, item_key AS itemKey,
				category, scope_type AS scopeType, scope_id AS scopeId,
				statement, updated_at AS updatedAt ${active} ORDER BY updated_at DESC`)
						.all(uid, reset) as Fact[];
					return {
						user,
						reset,
						facts,
						sourceReferences: sourceReferences.sort(),
					};
				})
				.deferred();
		} finally {
			source.close();
		}
	};
	const snapshot = readSnapshot();
	const checkpoint = createHash("sha256")
		.update(JSON.stringify(snapshot))
		.digest("hex");
	const verifyCheckpoint = () => {
		const live = createHash("sha256")
			.update(JSON.stringify(readSnapshot()))
			.digest("hex");
		if (live !== checkpoint) hold();
	};

	migrate(db, { migrationsFolder: resolve("drizzle") });
	db.insert(schema.users)
		.values({
			id: input.userId,
			email: `${randomUUID()}@test.invalid`,
			passwordHash: "no-login",
			name: snapshot.user.name,
			memoryEnabled: true,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({
			userId: input.userId,
			resetGeneration: snapshot.reset,
		})
		.run();
	const projectionStateId = randomUUID();
	db.insert(schema.memoryProjectionState)
		.values({
			id: projectionStateId,
			userId: input.userId,
			resetGeneration: snapshot.reset,
		})
		.run();
	for (const fact of snapshot.facts) {
		db.insert(schema.memoryProfileItems)
			.values({
				...fact,
				updatedAt: new Date(fact.updatedAt * 1000),
				userId: input.userId,
				resetGeneration: snapshot.reset,
				projectionStateId,
			})
			.run();
	}
	const projectIds = new Set(input.cases.map((item) => item.projectId));
	for (const projectId of projectIds) {
		if (projectId)
			db.insert(schema.projects)
				.values({
					id: projectId,
					userId: input.userId,
					name: "Benchmark project",
				})
				.run();
	}
	const results = [];
	for (const test of input.cases) {
		sqlite.exec("BEGIN");
		try {
			const conversationId = randomUUID();
			db.insert(schema.conversations)
				.values({
					id: conversationId,
					userId: input.userId,
					projectId: test.projectId,
					title: "Benchmark",
					memoryIncognito: false,
				})
				.run();
			const result = await getMemoryContext({
				userId: input.userId,
				conversationId,
				query: test.query,
				mode: "persona",
				includeEvidenceCandidates: false,
			});
			if (
				result.mode !== "persona" ||
				result.status === "error" ||
				result.source !== "active_memory_profile"
			)
				hold();
			results.push({ id: test.id, content: result.content });
		} finally {
			sqlite.exec("ROLLBACK");
		}
	}
	return { results, verifyCheckpoint };
}
