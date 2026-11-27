import { expect, it, vi } from "vitest";
import { resolveWorkingDocumentFileServing } from "../../knowledge/store/working-document-file-serving";
import { teamsUploadSource } from "./teams-upload-source";

vi.mock("../../knowledge/store/working-document-file-serving", () => ({
	resolveWorkingDocumentFileServing: vi.fn(),
}));
it("accepts only a current-turn selected artifact, serves its exact bytes under its owner and binds its hash", async () => {
	await expect(teamsUploadSource("u", "foreign", ["chosen"])).rejects.toThrow();
	expect(resolveWorkingDocumentFileServing).not.toHaveBeenCalled();
	vi.mocked(resolveWorkingDocumentFileServing).mockResolvedValue({
		ok: true,
		status: 206,
		body: new Uint8Array([0, 255]),
		headers: {
			"Content-Type": "image/png",
			"Content-Disposition": "attachment; filename*=UTF-8''photo.png",
			"Content-Range": "bytes 0-1/2",
		},
	});
	const found = await teamsUploadSource("u", "selected", ["chosen"]);
	expect(found.source).toMatchObject({
		id: "chosen",
		name: "photo.png",
		size: 2,
	});
	expect(found.source.sha256).toHaveLength(64);
	expect([...found.bytes]).toEqual([0, 255]);
	expect(resolveWorkingDocumentFileServing).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: "u",
			artifactId: "chosen",
			mode: "download",
		}),
	);
});
