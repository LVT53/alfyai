import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { readExportedConversations } from "$lib/shared/chatgpt-export";
import { importChatGPTData, packChatGPTUpload } from "./chatgpt-import";

function answeringWith(result: unknown) {
	return vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(result), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
}

function postedForm(fetchMock: ReturnType<typeof answeringWith>): FormData {
	const [, init] = fetchMock.mock.calls[0];
	return init?.body as FormData;
}

describe("importChatGPTData", () => {
	it("posts the export with the conversations the person ticked and the project", async () => {
		const fetchMock = answeringWith({
			jobId: "job-1",
			conversationIds: ["c-1"],
			errors: [],
		});
		const file = new File(["zip"], "export.zip", { type: "application/zip" });

		const result = await importChatGPTData(
			file,
			["conv-a", "conv-c"],
			"project-1",
			fetchMock,
		);

		expect(result.jobId).toBe("job-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("/api/chat/import");
		expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
		const form = postedForm(fetchMock);
		expect((form.get("file") as File).name).toBe("export.zip");
		expect(JSON.parse(form.get("conversationIds") as string)).toEqual([
			"conv-a",
			"conv-c",
		]);
		expect(form.get("projectId")).toBe("project-1");
	});

	it("sends no project when the person chose none", async () => {
		const fetchMock = answeringWith({
			jobId: "job-1",
			conversationIds: [],
			errors: [],
		});

		await importChatGPTData(
			new File(["zip"], "export.zip"),
			["conv-a"],
			null,
			fetchMock,
		);

		expect(postedForm(fetchMock).has("projectId")).toBe(false);
	});
});

describe("packChatGPTUpload", () => {
	const entries = [
		{ conversation_id: "conv-a", title: "A" },
		{ title: "No id" },
		{ id: "conv-b", title: "B", conversation_template_id: "g-p-1" },
		{ id: "conv-c", title: "C" },
	];

	async function readBack(file: File) {
		return readExportedConversations(await JSZip.loadAsync(file));
	}

	it("packs the ticked conversations alone, in the export's order, as an export the server reads", async () => {
		const file = await packChatGPTUpload(entries, ["conv-c", "conv-a"]);

		expect(file.name).toBe("chatgpt-export.zip");
		expect(await readBack(file)).toEqual({
			ok: true,
			entries: [entries[0], entries[3]],
		});
	});

	it("leaves out everything a real export carries besides its conversations", async () => {
		const file = await packChatGPTUpload(entries, ["conv-b"]);
		const zip = await JSZip.loadAsync(file);

		expect(Object.keys(zip.files).sort()).toEqual([
			"conversations-000.json",
			"export_manifest.json",
		]);
	});
});
