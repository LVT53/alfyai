import { describe, expect, it } from "vitest";
import * as AppModule from "../nodes/AppNode.svelte";
import * as ChartModule from "../nodes/ChartNode.svelte";
import * as ChecklistModule from "../nodes/ChecklistNode.svelte";
import * as FileModule from "../nodes/FileNode.svelte";
import * as LiveWebModule from "../nodes/LiveWebNode.svelte";
import * as MapModule from "../nodes/MapNode.svelte";
import * as MermaidModule from "../nodes/MermaidNode.svelte";
import * as PhotoModule from "../nodes/PhotoNode.svelte";
import { lazyNodeLoader } from "./lazy-nodes";

describe("the loaders of the blocks made from the chat", () => {
	it("has one for each of the six, and the checklist, and each resolves to that block's own content and its shell dress", async () => {
		const expected = [
			["chart", ChartModule.default, ChartModule.chartShell],
			["checklist", ChecklistModule.default, ChecklistModule.checklistShell],
			["file", FileModule.default, FileModule.fileShell],
			["app", AppModule.default, AppModule.appShell],
			["map", MapModule.default, MapModule.mapShell],
			["mermaid", MermaidModule.default, MermaidModule.mermaidShell],
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
			"nope",
			"toString",
			"__proto__",
		]) {
			expect(lazyNodeLoader(kind), kind).toBeNull();
		}
	});
});
