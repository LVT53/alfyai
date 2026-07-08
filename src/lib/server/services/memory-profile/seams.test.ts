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
});
