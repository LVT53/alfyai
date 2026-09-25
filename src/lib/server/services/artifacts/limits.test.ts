import { describe, expect, it } from "vitest";
import * as limits from "./limits";

// Every cap the artifact family enforces, pinned. None of them is
// environment-backed or admin-configurable in v1 (each constant's comment
// says why), so a change here is a product decision and should read as one in
// the diff rather than slipping in with an unrelated edit.
describe("artifact limits", () => {
	it("keeps the documented defaults", () => {
		// Every export, so a new cap cannot land without being pinned here too.
		expect(Object.fromEntries(Object.entries(limits))).toEqual({
			ARTIFACT_BODY_MAX_BYTES: 2 * 1024 * 1024,
			ARTIFACT_TITLE_MAX_CHARS: 200,
			ARTIFACT_VERSION_SUMMARY_MAX_CHARS: 500,
			ARTIFACT_VERSIONS_DEFAULT_LIMIT: 50,
			ARTIFACT_COMMENT_BODY_MAX_CHARS: 10_000,
			ARTIFACT_KV_MAX_KEYS: 200,
			ARTIFACT_KV_KEY_MAX_CHARS: 128,
			ARTIFACT_KV_VALUE_MAX_BYTES: 256 * 1024,
		});
	});
});
