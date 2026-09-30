import { describe, expect, it } from "vitest";
import AppNode from "../nodes/AppNode.svelte";
import FileNode from "../nodes/FileNode.svelte";
import MapNode from "../nodes/MapNode.svelte";
import { lazyNodeLoader } from "./lazy-nodes";

describe("the loaders of the blocks made from the chat", () => {
	it("has one for each of the three, and each resolves to that block's own node component", async () => {
		expect((await lazyNodeLoader("file")?.())?.default).toBe(FileNode);
		expect((await lazyNodeLoader("app")?.())?.default).toBe(AppNode);
		expect((await lazyNodeLoader("map")?.())?.default).toBe(MapNode);
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
