import { describe, expect, it } from "vitest";
import * as AppModule from "../nodes/AppNode.svelte";
import * as FileModule from "../nodes/FileNode.svelte";
import * as MapModule from "../nodes/MapNode.svelte";
import { lazyNodeLoader } from "./lazy-nodes";

describe("the loaders of the blocks made from the chat", () => {
	it("has one for each of the three, and each resolves to that block's own content and its shell dress", async () => {
		const expected = [
			["file", FileModule.default, FileModule.fileShell],
			["app", AppModule.default, AppModule.appShell],
			["map", MapModule.default, MapModule.mapShell],
		] as const;
		for (const [kind, content, shell] of expected) {
			const loaded = await lazyNodeLoader(kind)?.();
			expect(loaded?.default, kind).toBe(content);
			expect(loaded?.shell, kind).toBe(shell);
			expect(typeof loaded?.shell, kind).toBe("function");
		}
	});

	it("has none for a note-shaped block (those are in the editor already) or for a kind that has no node", () => {
		for (const kind of [
			"frame",
			"sticky",
			"text",
			"chart",
			"checklist",
			"photo",
			"liveweb",
			"nope",
			"toString",
			"__proto__",
		]) {
			expect(lazyNodeLoader(kind), kind).toBeNull();
		}
	});
});
