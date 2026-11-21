import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	parseMemoryBackfillArguments,
	readPrivateReceipt,
	unlocatedCurationReceipt,
} from "./memory-backfill";

it("defaults to read-only inspect with an explicit database and user", () => {
	expect(
		parseMemoryBackfillArguments([
			"--database",
			"/tmp/synthetic.db",
			"--user",
			"fixture",
		]).mode,
	).toBe("inspect");
	expect(() => parseMemoryBackfillArguments([])).toThrow(
		"explicit_database_and_user_required",
	);
});
it("refuses real-mode mutation before opening any database without explicit execution acknowledgement", () => {
	for (const mode of [
		"prepare",
		"cutover",
		"rollback",
		"restart-preparation",
		"approve-unlocated-curation",
	]) {
		const args = [
			"--database",
			"/tmp/synthetic.db",
			"--user",
			"fixture",
			"--mode",
			mode,
		];
		expect(() => parseMemoryBackfillArguments(args)).toThrow(
			"explicit_execution_acknowledgement_required",
		);
		expect(
			parseMemoryBackfillArguments([
				...args,
				"--execute",
				"yes",
				"--operator-ack",
				"approved-per-user-migration",
			]).mode,
		).toBe(mode);
	}
});
it("rejects duplicate or misspelled flags", () => {
	expect(() =>
		parseMemoryBackfillArguments(["--mode", "inspect", "--mode", "prepare"]),
	).toThrow("duplicate_argument");
	expect(() => parseMemoryBackfillArguments(["--mod", "prepare"])).toThrow(
		"invalid_arguments",
	);
});

it("reads an operator receipt only from a private file of this account", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "alfyai-receipt-")));
	try {
		const file = join(dir, "receipt.private.json");
		const link = join(dir, "link.private.json");
		writeFileSync(file, '{"userId":"fixture"}');
		chmodSync(file, 0o600);
		expect(readPrivateReceipt(file, "receipt_refused")).toEqual({
			userId: "fixture",
		});
		chmodSync(file, 0o640);
		expect(() => readPrivateReceipt(file, "receipt_refused")).toThrow(
			"receipt_refused",
		);
		chmodSync(file, 0o600);
		writeFileSync(file, `{"padding":"${"x".repeat(4096)}"}`);
		expect(() => readPrivateReceipt(file, "receipt_refused")).toThrow(
			"receipt_refused",
		);
		symlinkSync(file, link);
		for (const path of [undefined, "receipt.private.json", dir, link])
			expect(() => readPrivateReceipt(path, "receipt_refused")).toThrow(
				"receipt_refused",
			);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
it("accepts an unlocated-removal approval receipt only for the named account and manifest", () => {
	const receipt = {
		userId: "fixture",
		manifestId: "manifest",
		manifestHash: "a".repeat(64),
		approveUnlocatedCuration: true,
		actionIds: ["item:item:0:2021-01-01T00:00:00.000Z"],
	};
	const expected = { userId: "fixture", manifestId: "manifest" };
	expect(unlocatedCurationReceipt(receipt, expected)).toEqual({
		manifestHash: receipt.manifestHash,
		actionIds: receipt.actionIds,
	});
	for (const changed of [
		{ userId: "another" },
		{ manifestId: "another" },
		{ manifestHash: "A".repeat(64) },
		{ manifestHash: undefined },
		{ approveUnlocatedCuration: undefined },
		{ restartPreparation: true, approveUnlocatedCuration: undefined },
		{ actionIds: [] },
		{ actionIds: "item:item:0:2021-01-01T00:00:00.000Z" },
		{ actionIds: [""] },
		{ actionIds: [7] },
	])
		expect(() =>
			unlocatedCurationReceipt({ ...receipt, ...changed }, expected),
		).toThrow("private_curation_authorization_scope_mismatch");
	expect(() => unlocatedCurationReceipt(null, expected)).toThrow(
		"private_curation_authorization_scope_mismatch",
	);
});
