import { describe, expect, it } from "vitest";
import {
	ATTACHED_FILE_ID_PREFIX,
	attachedFileId,
	CHAT_BLOCKS_PER_KIND,
	fileBlockSource,
} from "./chat-blocks";

// A File block names a file by one id, and the id says which of the chat's two
// kinds of file it is: a produced file (a `chat_generated_files` row, the id the
// download and preview routes take) or a file the reader attached (an
// `artifacts` row, opened through the library's routes). The listing writes the
// id and the block opens through it, so both read this one convention.
describe("a File block's file id", () => {
	it("marks an attached file with the prefix the panel's own item id for it already uses", () => {
		expect(ATTACHED_FILE_ID_PREFIX).toBe("artifact:");
		expect(attachedFileId("art-1")).toBe("artifact:art-1");
	});

	it("reads a plain id as a produced file", () => {
		expect(fileBlockSource("chat-file-1")).toEqual({
			source: "produced",
			chatFileId: "chat-file-1",
		});
	});

	it("reads a prefixed id as an attached file, and gives back the artifact's own id", () => {
		expect(fileBlockSource(attachedFileId("art-1"))).toEqual({
			source: "attached",
			artifactId: "art-1",
		});
	});

	it("reads an id that is only the prefix, or nothing, as no file at all", () => {
		expect(fileBlockSource("artifact:")).toBeNull();
		expect(fileBlockSource("")).toBeNull();
	});

	it("keeps an id with the prefix in the middle of it a produced file's", () => {
		expect(fileBlockSource("x-artifact:1")).toEqual({
			source: "produced",
			chatFileId: "x-artifact:1",
		});
	});
});

describe("the listing's bound", () => {
	it("is a small number, so the menu it fills stays a menu", () => {
		expect(CHAT_BLOCKS_PER_KIND).toBeGreaterThan(0);
		expect(CHAT_BLOCKS_PER_KIND).toBeLessThanOrEqual(24);
	});
});
