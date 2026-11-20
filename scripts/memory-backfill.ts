#!/usr/bin/env tsx
/** Inspect by default. Mutations require explicit operator execution acknowledgement. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseMemoryBackfillArguments(args: string[]) {
	const allowed = new Set([
		"--mode",
		"--database",
		"--user",
		"--manifest",
		"--bank",
		"--authorization-file",
		"--synthetic-fixture",
		"--execute",
		"--operator-ack",
	]);
	if (
		args.some((arg, i) => i % 2 === 0 && !allowed.has(arg)) ||
		args.length % 2
	)
		throw Error("invalid_arguments");
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		if (values.has(args[i])) throw Error("duplicate_argument");
		values.set(args[i], args[i + 1]);
	}
	const mode = values.get("--mode") ?? "inspect";
	if (
		![
			"inspect",
			"prepare",
			"verify",
			"cutover",
			"rollback",
			"authorize-review",
			"recover-retained",
		].includes(mode)
	)
		throw Error("invalid_mode");
	const filename = values.get("--database");
	const userId = values.get("--user");
	if (!filename || !userId) throw Error("explicit_database_and_user_required");
	const synthetic = values.get("--synthetic-fixture") === "yes";
	if (
		!synthetic &&
		mode !== "inspect" &&
		mode !== "verify" &&
		(values.get("--execute") !== "yes" ||
			values.get("--operator-ack") !== "approved-per-user-migration")
	)
		throw Error("explicit_execution_acknowledgement_required");
	return { values, mode, filename, userId, synthetic };
}
async function main() {
	const { values, mode, filename, userId, synthetic } =
		parseMemoryBackfillArguments(process.argv.slice(2));
	const path = realpathSync(filename);
	const root = realpathSync(tmpdir());
	const inside = relative(root, path);
	if (synthetic && (inside.startsWith("..") || isAbsolute(inside) || !inside))
		throw Error("synthetic_temporary_database_required");
	if (
		synthetic &&
		readFileSync(
			resolve(dirname(path), ".alfyai-memory-synthetic"),
			"utf8",
		).trim() !== "alfyai-memory-synthetic-v1"
	)
		throw Error("synthetic_marker_required");
	process.env.DATABASE_PATH = path;
	const { db, sqlite } = await import("../src/lib/server/db");
	const { users } = await import("../src/lib/server/db/schema");
	if (
		synthetic &&
		db
			.select()
			.from(users)
			.all()
			.some((u) => !u.email.endsWith("@test.invalid"))
	)
		throw Error("non_synthetic_accounts_refused");
	const m = await import("../src/lib/server/services/memory-profile/migration");
	try {
		let summary: unknown;
		if (mode === "inspect") {
			const inventory = m.inspectMemoryMigration(userId);
			summary = {
				mode,
				eligible: inventory.sources.filter((s) => s.eligibility === "eligible")
					.length,
				uncertain: inventory.sources.filter(
					(s) => s.eligibility === "uncertain",
				).length,
				excluded: inventory.sources.filter((s) => s.eligibility === "excluded")
					.length,
				exceptions: inventory.exceptions.length,
				authoredActions: inventory.actions.filter((a) => a.kind === "authored")
					.length,
				exclusions: inventory.actions.filter((a) => a.kind === "remove").length,
				endorsements: inventory.actions.filter((a) => a.kind === "endorsement")
					.length,
				holdHistory: inventory.holdHistory,
			};
		} else if (mode === "recover-retained") {
			const bankId = values.get("--bank");
			const manifestId = values.get("--manifest");
			if (!bankId || !manifestId)
				throw Error("explicit_bank_and_manifest_required");
			const { recoverAcknowledgedHistoricalMigration } = await import(
				"../src/lib/server/services/memory-profile/migration-recovery"
			);
			summary = {
				mode,
				...(await recoverAcknowledgedHistoricalMigration({
					userId,
					manifestId,
					bankId,
				})),
			};
		} else if (mode === "authorize-review") {
			const { authorizeMemoryQuarantine } = await import(
				"../src/lib/server/services/memory-profile/quarantine"
			);
			const file = values.get("--authorization-file");
			if (!file || !isAbsolute(file) || realpathSync(file) !== file)
				throw Error("private_authorization_file_required");
			const info = lstatSync(file);
			if (
				!info.isFile() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0 ||
				info.size > 128 * 1024
			)
				throw Error("private_authorization_file_required");
			const authorization = JSON.parse(readFileSync(file, "utf8"));
			if (
				authorization.userId !== userId ||
				authorization.manifestId !== values.get("--manifest")
			)
				throw Error("authorization_identity_mismatch");
			summary = { mode, ...authorizeMemoryQuarantine(userId, authorization) };
		} else if (mode === "prepare")
			summary = await m.prepareMemoryMigration(userId);
		else {
			const id = values.get("--manifest");
			if (!id) throw Error("manifest_required");
			summary =
				mode === "verify"
					? m.verifyMemoryMigration(userId, id)
					: mode === "cutover"
						? m.cutoverMemoryMigration(userId, id)
						: m.rollbackMemoryMigration(userId, id);
		}
		console.log(JSON.stringify(summary));
	} finally {
		sqlite.close();
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch(() => {
		console.error(
			"Memory rehearsal failed; inspect the restricted fixture and manifest. No source text or credentials were logged.",
		);
		process.exitCode = 1;
	});
