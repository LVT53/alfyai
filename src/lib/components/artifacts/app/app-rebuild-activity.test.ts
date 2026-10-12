import { describe, expect, it } from "vitest";
import { buildAppRebuildActivity } from "./app-rebuild-activity";

// F2 (ruling 77): "change this App" in the chat rebuilds that App in place
// (`edit_artifact` with an `instruction`). The open panel has to know: veil the
// frame while it runs, load the new version when it lands.
describe("buildAppRebuildActivity", () => {
	const running = {
		name: "edit_artifact",
		callId: "call-1",
		status: "running" as const,
		input: { artifactId: "app-1", instruction: "Add a Reset button." },
	};

	it("is running while the call is in flight, before the server has said what the item is", () => {
		expect(buildAppRebuildActivity(running)).toEqual({
			key: "call-1",
			artifactId: "app-1",
			toolName: "edit_artifact",
			status: "running",
			label: null,
			patches: [],
			refusedBlocks: [],
			appliedCount: 0,
		});
	});

	it("is applied once the call is done, with the version it wrote", () => {
		const activity = buildAppRebuildActivity({
			...running,
			status: "done",
			metadata: {
				ok: true,
				artifactId: "app-1",
				artifactKind: "app",
				versionId: "version-2",
			},
		});
		expect(activity).toMatchObject({
			key: "call-1",
			artifactId: "app-1",
			status: "applied",
			versionId: "version-2",
			// Nothing here is a block or an op: the panel's Document marks and the row's
			// pending pill both read this as "no change to mark".
			appliedCount: 0,
		});
	});

	it("is failed when the call failed or the rebuild did not land", () => {
		expect(
			buildAppRebuildActivity({ ...running, status: "failed" })?.status,
		).toBe("failed");
		expect(
			buildAppRebuildActivity({
				...running,
				status: "done",
				metadata: { ok: false, artifactKind: "app" },
			})?.status,
		).toBe("failed");
	});

	it("names the item from the metadata when the input has no id", () => {
		const activity = buildAppRebuildActivity({
			...running,
			input: { instruction: "Add a Reset button." },
			status: "done",
			metadata: { ok: true, artifactId: "app-9", versionId: "v" },
		});
		expect(activity?.artifactId).toBe("app-9");
	});

	it("is nothing for any other call: a Document's patches, a board's ops, a create", () => {
		for (const segment of [
			{ ...running, input: { artifactId: "doc-1", patches: [] } },
			{ ...running, input: { artifactId: "board-1", ops: [{ op: "move" }] } },
			{
				...running,
				name: "create_artifact",
				input: { artifactType: "app", title: "Timer", body: "A timer" },
			},
			{ ...running, input: { artifactId: "app-1", instruction: "  " } },
		]) {
			expect(buildAppRebuildActivity(segment)).toBeNull();
		}
	});
});
