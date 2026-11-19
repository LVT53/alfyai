import { expect, it } from "vitest";
import { parseMemoryBackfillArguments } from "./memory-backfill";

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
	for (const mode of ["prepare", "cutover", "rollback"]) {
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
