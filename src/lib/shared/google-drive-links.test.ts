import { describe, expect, it } from "vitest";
import { googleDriveDocumentUrl } from "./google-drive-links";

describe("Google Drive document links", () => {
	it.each([
		"https://drive.google.com/file/d/file-1/view?resourcekey=abc",
		"https://drive.google.com/drive/u/1/folders/xyz",
		"https://docs.google.com/spreadsheets/d/doc_1/edit#gid=0",
		"https://drive.google.com/open?id=item",
	])("retains a provider URL %s", (url) =>
		expect(googleDriveDocumentUrl(url)).toBe(url),
	);
	it.each([
		"http://drive.google.com/open?id=x",
		"https://drive.google.com.evil.test/file/d/id/view",
		"https://user@docs.google.com/document/d/id/edit",
		"https://drive.google.com:444/file/d/id",
		"https://docs.google.com/url?q=https://example.com",
		"https://drive.google.com/open",
		"https://drive.google.com/uc?id=x",
		"https://other.google.com/file/d/id",
	])("rejects %s", (url) =>
		expect(googleDriveDocumentUrl(url)).toBeUndefined(),
	);
});
