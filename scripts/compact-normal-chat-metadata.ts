/** Explicit maintenance only. Never called by app/bootstrap or a general migration. */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { readNormalChatOutputEvent } from "../src/lib/services/ai-sdk-ui-stream-contract";
import {
	compactNormalChatOutputEvents,
	projectNormalChatOutput,
} from "../src/lib/shared/normal-chat-output";

type Scope = { userId: string; conversationId: string; messageId: string };
const STAGING_DB =
	"/home/alfydesign/apps/langflow-chat-dev/shared/data/chat.db";
const MAX_BYTES = 32 * 1024 * 1024;
export function assertRepairDatabasePath(path: string, apply: boolean) {
	if (apply && path !== STAGING_DB)
		throw new Error("Apply is restricted to the resolved staging database");
}
function scopesFrom(value: unknown): Scope[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100)
		throw new Error("Manifest must contain 1 to 100 exact scopes");
	const seen = new Set<string>();
	return value.map((row: unknown) => {
		if (!row || typeof row !== "object") throw new Error("Invalid scope");
		const input = row as Record<string, unknown>;
		for (const key of ["userId", "conversationId", "messageId"] as const)
			if (
				typeof input[key] !== "string" ||
				input[key].length === 0 ||
				input[key].length > 256
			)
				throw new Error("Invalid scope identity");
		const scope = input as Scope;
		if (seen.has(scope.messageId)) throw new Error("Duplicate message ID");
		seen.add(scope.messageId);
		return scope;
	});
}
function compactMetadata(raw: string): string {
	const metadata: unknown = JSON.parse(raw);
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		throw new Error("Invalid message metadata");
	const record = metadata as Record<string, unknown>;
	if (record.normalChatOutput === undefined) return raw;
	const value = record.normalChatOutput;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid output metadata");
	const output = value as Record<string, unknown>;
	if (output.version !== 1 || !Array.isArray(output.events))
		throw new Error("Unknown output metadata version");
	const events = output.events.map(readNormalChatOutputEvent);
	if (events.some((event) => !event)) throw new Error("Invalid output event");
	const valid = events.filter((event) => event !== null);
	const compact = compactNormalChatOutputEvents(valid);
	if (compact.length >= valid.length) return raw;
	if (
		JSON.stringify(projectNormalChatOutput(valid)) !==
		JSON.stringify(projectNormalChatOutput(compact))
	)
		throw new Error("Compaction changes output projection");
	const result = JSON.stringify({
		...record,
		normalChatOutput: { ...output, events: compact },
	});
	return Buffer.byteLength(result) < Buffer.byteLength(raw) ? result : raw;
}
export function repairNormalChatMetadata(
	sqlite: Database.Database,
	manifest: unknown,
	apply: boolean,
) {
	const scopes = scopesFrom(manifest);
	const run = sqlite.transaction(() => {
		const scoped =
			"FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.conversation_id=? AND c.user_id=? AND m.role='assistant'";
		const size = sqlite.prepare(
			`SELECT length(CAST(coalesce(m.metadata_json,'') AS BLOB)) AS bytes ${scoped}`,
		);
		let beforeBytes = 0;
		for (const scope of scopes) {
			const row = size.get(
				scope.messageId,
				scope.conversationId,
				scope.userId,
			) as { bytes: number } | undefined;
			if (!row) throw new Error("Missing or unauthorized assistant scope");
			beforeBytes += row.bytes;
			if (beforeBytes > MAX_BYTES)
				throw new Error("Selected metadata exceeds the 32 MiB batch bound");
		}
		const read = sqlite.prepare(`SELECT m.metadata_json AS metadata ${scoped}`);
		const write = apply
			? sqlite.prepare(
					"UPDATE messages SET metadata_json=? WHERE id=? AND conversation_id=? AND metadata_json=?",
				)
			: undefined;
		let changed = 0,
			afterBytes = 0;
		for (const scope of scopes) {
			const { metadata } = read.get(
				scope.messageId,
				scope.conversationId,
				scope.userId,
			) as { metadata: string | null };
			if (metadata === null) continue;
			const compact = compactMetadata(metadata);
			afterBytes += Buffer.byteLength(compact);
			if (compact === metadata) continue;
			changed++;
			if (
				write &&
				write.run(compact, scope.messageId, scope.conversationId, metadata)
					.changes !== 1
			)
				throw new Error("Concurrent metadata change");
		}
		return { changed, beforeBytes, afterBytes };
	});
	return apply ? run.immediate() : run.deferred();
}
function main() {
	const { values } = parseArgs({
		options: {
			database: { type: "string" },
			manifest: { type: "string" },
			apply: { type: "boolean", default: false },
			report: { type: "string" },
		},
	});
	if (!values.database || !values.manifest)
		throw new Error(
			"Use --database PATH --manifest PATH [--apply] [--report PATH]; default is a read-only dry run",
		);
	const path = realpathSync(resolve(values.database));
	assertRepairDatabasePath(path, values.apply);
	const manifest = scopesFrom(
		JSON.parse(readFileSync(values.manifest, "utf8")),
	);
	// Reserve the report before any mutation; an existing/unwritable report must
	// never turn a committed repair into an apparently refused operation.
	if (values.report)
		writeFileSync(values.report, `${JSON.stringify({ status: "started" })}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	const sqlite = new Database(path, {
		readonly: !values.apply,
		fileMustExist: true,
	});
	try {
		if (!values.apply) sqlite.pragma("query_only = ON");
		const report = {
			mode: values.apply ? "apply" : "dry-run",
			selected: manifest.length,
			...repairNormalChatMetadata(sqlite, manifest, values.apply),
		};
		const json = `${JSON.stringify(report, null, 2)}\n`;
		if (values.report)
			writeFileSync(values.report, json, { flag: "w", mode: 0o600 });
		process.stdout.write(json);
	} finally {
		sqlite.close();
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		main();
	} catch {
		process.stderr.write(
			"Metadata repair refused or failed; no content is printed.\n",
		);
		process.exitCode = 1;
	}
}
