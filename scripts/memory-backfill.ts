#!/usr/bin/env tsx
/** Inspect by default. Mutations require explicit operator execution acknowledgement. */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
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
		"--authorization-hash",
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
			"repair-selective-retain",
			"rewind-unpublished",
			"restart-preparation",
			"approve-unlocated-curation",
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
/** A small receipt file, by its exact absolute path, that only its owner can read. */
export function readPrivateReceipt(
	file: string | undefined,
	error: string,
): unknown {
	let canonical: string | undefined;
	try {
		canonical = file && isAbsolute(file) ? realpathSync(file) : undefined;
	} catch {
		canonical = undefined;
	}
	if (!file || canonical !== file) throw Error(error);
	const info = lstatSync(file);
	if (
		!info.isFile() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o077) !== 0 ||
		info.size > 4096
	)
		throw Error(error);
	return JSON.parse(readFileSync(file, "utf8"));
}
/** An approval to check unlocated removals by meaning, for one account's current manifest. */
export function unlocatedCurationReceipt(
	receipt: unknown,
	expected: { userId: string; manifestId: string },
) {
	const proof =
		receipt && typeof receipt === "object"
			? (receipt as Record<string, unknown>)
			: {};
	const { manifestHash, actionIds } = proof;
	if (
		proof.userId !== expected.userId ||
		proof.manifestId !== expected.manifestId ||
		proof.approveUnlocatedCuration !== true ||
		typeof manifestHash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(manifestHash) ||
		!Array.isArray(actionIds) ||
		!actionIds.length ||
		actionIds.some((id) => typeof id !== "string" || !id)
	)
		throw Error("private_curation_authorization_scope_mismatch");
	return { manifestHash, actionIds: actionIds as string[] };
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
				// Content-free IDs for an approval receipt; see the runbook.
				unlocatedRemovals: inventory.actions
					.filter(
						(a) =>
							!a.curateAllHistory &&
							m.unlocatedCurationApprovable(inventory, a.id),
					)
					.map((a) => a.id),
				approvedUnlocatedRemovals: inventory.actions
					.filter((a) => a.curateAllHistory)
					.map((a) => a.id),
			};
		} else if (
			mode === "recover-retained" ||
			mode === "repair-selective-retain"
		) {
			const bankId = values.get("--bank");
			const manifestId = values.get("--manifest");
			if (!bankId || !manifestId)
				throw Error("explicit_bank_and_manifest_required");
			const { recoverAcknowledgedHistoricalMigration } = await import(
				"../src/lib/server/services/memory-profile/migration-recovery"
			);
			const file = values.get("--authorization-file");
			const selective = mode === "repair-selective-retain";
			let reviewedMerge: { sourceId: string; snapshotHash: string } | undefined;
			let selectiveRepair:
				| { sourceId: string; nativeFactId: string; snapshotHash: string }
				| undefined;
			const approvedHash = values.get("--authorization-hash");
			if (selective || file || approvedHash) {
				if (
					!file ||
					!approvedHash ||
					!/^[a-f0-9]{64}$/u.test(approvedHash) ||
					!isAbsolute(file) ||
					realpathSync(file) !== file
				)
					throw Error("private_merge_authorization_file_required");
				const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
				let bytes: Buffer;
				try {
					const info = fstatSync(fd);
					if (
						!info.isFile() ||
						info.uid !== process.getuid?.() ||
						(info.mode & 0o777) !== 0o600 ||
						info.size > 4096
					)
						throw Error("private_merge_authorization_file_required");
					bytes = readFileSync(fd);
				} finally {
					closeSync(fd);
				}
				if (
					bytes.length > 4096 ||
					createHash("sha256").update(bytes).digest("hex") !== approvedHash
				)
					throw Error("private_merge_authorization_scope_mismatch");
				const receipt = JSON.parse(bytes.toString("utf8"));
				if (
					receipt.userId !== userId ||
					receipt.manifestId !== manifestId ||
					receipt.bankId !== bankId ||
					(selective
						? receipt.policy !== "selective-retain-repair-v1" ||
							typeof receipt.nativeFactId !== "string" ||
							!receipt.nativeFactId
						: receipt.verdict !== "clear" ||
							receipt.verdictSource !== "local_model" ||
							receipt.model !== "qwen3-6-27b" ||
							receipt.checks !== 2 ||
							receipt.policy !== "reviewed-historical-merge-v1") ||
					typeof receipt.sourceId !== "string" ||
					!receipt.sourceId ||
					typeof receipt.snapshotHash !== "string" ||
					!/^[a-f0-9]{64}$/u.test(receipt.snapshotHash)
				)
					throw Error("private_merge_authorization_scope_mismatch");
				if (selective)
					selectiveRepair = {
						sourceId: receipt.sourceId,
						nativeFactId: receipt.nativeFactId,
						snapshotHash: receipt.snapshotHash,
					};
				else
					reviewedMerge = {
						sourceId: receipt.sourceId,
						snapshotHash: receipt.snapshotHash,
					};
			}

			summary = {
				mode,
				...(await recoverAcknowledgedHistoricalMigration({
					userId,
					manifestId,
					bankId,
					reviewedMerge,
					selectiveRepair,
				})),
			};
		} else if (mode === "rewind-unpublished") {
			const file = values.get("--authorization-file");
			const bankId = values.get("--bank");
			const manifestId = values.get("--manifest");
			if (
				!file ||
				!isAbsolute(file) ||
				realpathSync(file) !== file ||
				!bankId ||
				!manifestId
			)
				throw Error("private_rewind_authorization_file_required");
			const info = lstatSync(file);
			if (
				!info.isFile() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0 ||
				info.size > 16 * 1024
			)
				throw Error("private_rewind_authorization_file_required");
			const proof = JSON.parse(readFileSync(file, "utf8"));
			if (
				proof.userId !== userId ||
				proof.bankId !== bankId ||
				proof.manifestId !== manifestId ||
				typeof proof.manifestHash !== "string" ||
				!/^[a-f0-9]{64}$/u.test(proof.manifestHash)
			)
				throw Error("private_rewind_authorization_scope_mismatch");
			const { rewindUnpublishedMigrationSources } = await import(
				"../src/lib/server/services/memory-profile/migration-pending-rewind"
			);
			summary = {
				mode,
				...(await rewindUnpublishedMigrationSources({
					userId,
					bankId,
					manifestId,
					manifestHash: proof.manifestHash,
					sourceIds: proof.sourceIds,
					holdCorrectionConflict: proof.holdCorrectionConflict === true,
					allowOrdinaryConsolidation: proof.allowOrdinaryConsolidation === true,
				})),
			};
		} else if (mode === "restart-preparation") {
			const manifestId = values.get("--manifest");
			if (!manifestId)
				throw Error("private_restart_authorization_file_required");
			const proof = readPrivateReceipt(
				values.get("--authorization-file"),
				"private_restart_authorization_file_required",
			) as Record<string, unknown>;
			if (
				proof.userId !== userId ||
				proof.manifestId !== manifestId ||
				proof.restartPreparation !== true ||
				typeof proof.manifestHash !== "string" ||
				!/^[a-f0-9]{64}$/u.test(proof.manifestHash)
			)
				throw Error("private_restart_authorization_scope_mismatch");
			summary = {
				mode,
				...(await m.restartMemoryPreparation(userId, {
					manifestId,
					manifestHash: proof.manifestHash,
				})),
			};
		} else if (mode === "approve-unlocated-curation") {
			const manifestId = values.get("--manifest");
			if (!manifestId)
				throw Error("private_curation_authorization_file_required");
			const proof = unlocatedCurationReceipt(
				readPrivateReceipt(
					values.get("--authorization-file"),
					"private_curation_authorization_file_required",
				),
				{ userId, manifestId },
			);
			summary = {
				mode,
				...m.approveUnlocatedMemoryCuration(userId, { manifestId, ...proof }),
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
