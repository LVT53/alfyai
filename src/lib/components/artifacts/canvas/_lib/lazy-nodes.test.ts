import { describe, expect, it } from "vitest";
import * as AppModule from "../nodes/AppNode.svelte";
import * as FileModule from "../nodes/FileNode.svelte";
import * as LiveWebModule from "../nodes/LiveWebNode.svelte";
import * as MapModule from "../nodes/MapNode.svelte";
import * as PhotoModule from "../nodes/PhotoNode.svelte";
import { lazyNodeLoader } from "./lazy-nodes";

describe("the loaders of the blocks made from the chat", () => {
	it("has one for each of the five, and each resolves to that block's own content and its shell dress", async () => {
		const expected = [
			["file", FileModule.default, FileModule.fileShell],
			["app", AppModule.default, AppModule.appShell],
			["map", MapModule.default, MapModule.mapShell],
			["liveweb", LiveWebModule.default, LiveWebModule.livewebShell],
		] as const;
		for (const [kind, content, shell] of expected) {
			const loaded = await lazyNodeLoader(kind)?.();
			expect(loaded?.default, kind).toBe(content);
			expect(loaded?.shell, kind).toBe(shell);
			expect(typeof loaded?.shell, kind).toBe("function");
		}
	});

	// Photos say nothing of themselves to the shell but the kind's own name.
	it("loads photos' own content, and dresses the shell with nothing", async () => {
		const loaded = await lazyNodeLoader("photo")?.();
		expect(loaded?.default).toBe(PhotoModule.default);
		expect(loaded?.shell).toBeUndefined();
	});

	it("has none for a note-shaped block (those are in the editor already) or for a kind that has no node", () => {
		for (const kind of [
			"frame",
			"sticky",
			"text",
			"chart",
			"checklist",
			"nope",
			"toString",
			"__proto__",
		]) {
			expect(lazyNodeLoader(kind), kind).toBeNull();
		}
	});
});
