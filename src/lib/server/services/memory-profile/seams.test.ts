import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serviceRoot = "src/lib/server/services";

function readService(relativePath: string): string {
	return readFileSync(`${serviceRoot}/${relativePath}`, "utf8");
}

describe("memory profile module seams", () => {
	it("keeps implementation bodies in owned modules instead of a catch-all file", () => {
		expect(existsSync(`${serviceRoot}/memory-profile/implementation.ts`)).toBe(
			false,
		);

		const ownedModules = [
			"types.ts",
			"scope.ts",
			"reset-generation.ts",
			"projection-store.ts",
			"read-model.ts",
			"active-context.ts",
			"telemetry.ts",
			"review.ts",
			"dirty-ledger.ts",
		];

		for (const modulePath of ownedModules) {
			const source = readService(`memory-profile/${modulePath}`);
			expect(source).not.toContain('from "./implementation"');
			expect(source.length).toBeGreaterThan(500);
		}
	});

	it("keeps prompt-context callers on active-context and telemetry seams", () => {
		const contextSelection = readService("chat-turn/context-selection.ts");
		const memoryContext = readService("memory-context.ts");

		expect(contextSelection).not.toContain('from "../memory-profile"');
		expect(contextSelection).toContain(
			'from "../memory-profile/active-context"',
		);
		expect(contextSelection).toContain('from "../memory-profile/telemetry"');

		expect(memoryContext).not.toContain(
			'from "$lib/server/services/memory-profile"',
		);
		expect(memoryContext).toContain(
			'from "$lib/server/services/memory-profile/active-context"',
		);
		expect(memoryContext).toContain(
			'from "$lib/server/services/memory-profile/telemetry"',
		);
	});

	it("keeps active profile reads detached from the control-model adapter", () => {
		const activeContext = readService("memory-profile/active-context.ts");
		const readModel = readService("memory-profile/read-model.ts");

		expect(activeContext).not.toContain("normal-chat-control-model");
		expect(readModel).not.toContain("normal-chat-control-model");
	});

	it("routes every memoryProfileItems write + revision bump through the projection store", () => {
		// The projection store is the SOLE write authority for the item table and
		// the projection revision. No other module may issue a raw
		// db.insert/update(memoryProfileItems) or hand-bump the revision — they must
		// compose the store's mutation door instead. This keeps the optimistic-
		// concurrency invariant (revision claim + stale_projection) unskippable.
		const writerModules = [
			"memory-profile/review.ts",
			"memory-consolidation/steps.ts",
			"memory-recuration.ts",
			"memory-judge/index.ts",
		];
		for (const modulePath of writerModules) {
			const source = readService(modulePath);
			expect(source).not.toContain("insert(memoryProfileItems)");
			expect(source).not.toContain("update(memoryProfileItems)");
			expect(source).not.toContain("bumpProjectionRevision");
		}

		// The escape hatch is gone: bumpProjectionRevision exists nowhere, and the
		// only module that writes the item table is the store itself.
		const store = readService("memory-profile/projection-store.ts");
		expect(store).not.toContain("bumpProjectionRevision");
		expect(store).toContain("update(memoryProfileItems)");
		expect(store).toContain("insert(memoryProfileItems)");
	});
});
