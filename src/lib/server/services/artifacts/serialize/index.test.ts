import { describe, expect, it } from "vitest";
import type { VideoVersionBody } from "$lib/shared/artifacts/video-body";
import { type FileArtifactDescriptor, getArtifactSerializer } from "./index";

describe("the artifact serializer registry", () => {
	it("resolves the file serializer by kind", () => {
		expect(getArtifactSerializer("file")?.kind).toBe("file");
	});

	it("resolves the document serializer by kind (Slice 1)", () => {
		expect(getArtifactSerializer("document")?.kind).toBe("document");
	});

	it("resolves the video serializer by kind (slice 2)", () => {
		expect(getArtifactSerializer("video")?.kind).toBe("video");
	});

	it("answers null — not a throw — for a kind whose slice has not landed", () => {
		for (const kind of ["app", "slides"] as const) {
			expect(getArtifactSerializer(kind)).toBeNull();
		}
	});
});

describe("the file serializer", () => {
	const descriptor: FileArtifactDescriptor = {
		files: [
			{
				chatFileId: "file-1",
				filename: "Vienna trip summary.pdf",
				mimeType: "application/pdf",
			},
			{
				chatFileId: "file-2",
				filename: "Vienna trip summary.docx",
				mimeType: null,
			},
		],
	};

	it("round-trips a produced-file descriptor", () => {
		const serializer = getArtifactSerializer("file");
		if (!serializer) throw new Error("file serializer missing");

		const stored = serializer.serialize(descriptor);
		expect(serializer.parse(stored)).toEqual(descriptor);
	});

	it("serialises deterministically, whatever the key order it was handed", () => {
		const serializer = getArtifactSerializer("file");
		if (!serializer) throw new Error("file serializer missing");

		const reordered = {
			files: descriptor.files.map((file) => ({
				mimeType: file.mimeType,
				filename: file.filename,
				chatFileId: file.chatFileId,
			})),
		};
		expect(serializer.serialize(reordered)).toBe(
			serializer.serialize(descriptor),
		);
	});

	it("parses anything that is not a descriptor to null instead of throwing", () => {
		const serializer = getArtifactSerializer("file");
		if (!serializer) throw new Error("file serializer missing");

		for (const stored of [
			"",
			"{not json",
			"null",
			"[]",
			JSON.stringify({ files: "file-1" }),
			JSON.stringify({ files: [{ chatFileId: "", filename: "x" }] }),
			JSON.stringify({ files: [{ chatFileId: "f", filename: 3 }] }),
		]) {
			expect(serializer.parse(stored)).toBeNull();
		}
	});
});

describe("the video serializer", () => {
	const body: VideoVersionBody = {
		v: 1,
		fileId: "video-file-1",
		posterFileId: "video-file-1",
		width: 1280,
		height: 704,
		durationMs: 5000,
		sourceFileId: "still-file-1",
	};

	it("round-trips a video body through the registry", () => {
		const serializer = getArtifactSerializer("video");
		if (!serializer) throw new Error("video serializer missing");
		expect(serializer.parse(serializer.serialize(body))).toEqual(body);
	});

	it("serialises deterministically, whatever key order it was handed", () => {
		const serializer = getArtifactSerializer("video");
		if (!serializer) throw new Error("video serializer missing");
		const reordered = {
			sourceFileId: body.sourceFileId,
			durationMs: body.durationMs,
			height: body.height,
			width: body.width,
			posterFileId: body.posterFileId,
			fileId: body.fileId,
			v: 1,
		} as VideoVersionBody;
		expect(serializer.serialize(reordered)).toBe(serializer.serialize(body));
	});

	it("parses anything that is not a video body to null instead of throwing", () => {
		const serializer = getArtifactSerializer("video");
		if (!serializer) throw new Error("video serializer missing");
		for (const stored of [
			"",
			"{not json",
			"null",
			"[]",
			JSON.stringify({ ...body, fileId: "" }),
			JSON.stringify({ ...body, durationMs: 0 }),
		]) {
			expect(serializer.parse(stored)).toBeNull();
		}
	});
});
