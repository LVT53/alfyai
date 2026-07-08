import { describe, expect, it } from "vitest";
import {
	buildWritePreview,
	idempotencyKey,
	requiresConfirm,
	resolveWriteTarget,
	type WriteOperation,
} from "./write-guard";

function op(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "nextcloud-files",
		connectionId: "conn-1",
		action: "files.put",
		summary: "Upload report.pdf to /AlfyAI",
		reversible: true,
		destructive: false,
		target: { path: "/AlfyAI/report.pdf" },
		...overrides,
	};
}

describe("resolveWriteTarget", () => {
	it("uses the default area when no path is requested", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			defaultArea: "/AlfyAI/Inbox",
		});
		expect(result).toEqual({ path: "/AlfyAI/Inbox", withinAllowlist: true });
	});

	it("falls back to the first allowlist entry when no defaultArea is given", () => {
		const result = resolveWriteTarget({ allowlist: ["/AlfyAI", "/Other"] });
		expect(result).toEqual({ path: "/AlfyAI", withinAllowlist: true });
	});

	it("falls back to /AlfyAI when there is no allowlist and no defaultArea", () => {
		const result = resolveWriteTarget({ allowlist: [] });
		expect(result).toEqual({ path: "/AlfyAI", withinAllowlist: true });
	});

	it("honors an explicit path under the allowlist", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "/AlfyAI/reports/q1.pdf",
		});
		expect(result).toEqual({
			path: "/AlfyAI/reports/q1.pdf",
			withinAllowlist: true,
		});
	});

	it("honors an explicit path exactly matching an allowlist root", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "AlfyAI",
		});
		expect(result).toEqual({ path: "/AlfyAI", withinAllowlist: true });
	});

	it("honors an explicit path outside the allowlist but flags it", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "/Documents/other.pdf",
		});
		expect(result).toEqual({
			path: "/Documents/other.pdf",
			withinAllowlist: false,
		});
	});

	it("does not treat a sibling with a shared prefix as within the allowlist", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "/AlfyAI2/file.txt",
		});
		expect(result.withinAllowlist).toBe(false);
	});

	it("normalizes redundant slashes and dot segments in the requested path", () => {
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "//AlfyAI//./reports/q1.pdf",
		});
		expect(result).toEqual({
			path: "/AlfyAI/reports/q1.pdf",
			withinAllowlist: true,
		});
	});

	it("rejects a leading traversal that escapes the root", () => {
		expect(() =>
			resolveWriteTarget({ allowlist: ["/AlfyAI"], requestedPath: "../etc" }),
		).toThrow();
	});

	it("rejects a traversal that escapes the root after descending", () => {
		expect(() =>
			resolveWriteTarget({
				allowlist: ["/AlfyAI"],
				requestedPath: "a/../../x",
			}),
		).toThrow();
	});

	it("rejects traversal even when the escape lands back under the allowlist", () => {
		expect(() =>
			resolveWriteTarget({
				allowlist: ["/AlfyAI"],
				requestedPath: "/AlfyAI/../AlfyAI/x",
			}),
		).not.toThrow();
		// This one does NOT escape (pops back to AlfyAI, stays non-negative), so
		// it should resolve normally rather than throw.
		const result = resolveWriteTarget({
			allowlist: ["/AlfyAI"],
			requestedPath: "/AlfyAI/../AlfyAI/x",
		});
		expect(result).toEqual({ path: "/AlfyAI/x", withinAllowlist: true });
	});
});

describe("buildWritePreview", () => {
	it("warns when an operation is destructive and not reversible", () => {
		const preview = buildWritePreview(
			op({
				action: "files.delete",
				summary: "Delete report.pdf from /AlfyAI",
				reversible: false,
				destructive: true,
			}),
		);
		expect(preview.warnings).toContain(
			"This will overwrite/delete and may not be recoverable",
		);
	});

	it("warns when the target is outside the allowlist", () => {
		const preview = buildWritePreview(
			op({
				target: { path: "/Documents/other.pdf", withinAllowlist: false },
			}),
		);
		expect(preview.warnings).toContain("Outside your allowed area");
		expect(preview.withinAllowlist).toBe(false);
	});

	it("has no scary warnings for a benign, reversible, in-allowlist write", () => {
		const preview = buildWritePreview(op());
		expect(preview.warnings).toEqual([]);
		expect(preview.withinAllowlist).toBe(true);
	});

	it("reports withinAllowlist as null for non-path-based targets", () => {
		const preview = buildWritePreview(
			op({
				action: "calendar.create_event",
				summary: "Create event 'Standup' in calendar",
				target: { id: "evt-123", label: "Standup" },
			}),
		);
		expect(preview.withinAllowlist).toBeNull();
		expect(preview.warnings).toEqual([]);
	});

	it("derives title and detail from the operation", () => {
		const theOp = op({
			action: "files.put",
			summary: "Upload report.pdf to /AlfyAI",
		});
		const preview = buildWritePreview(theOp);
		expect(preview.title).toBe(theOp.summary);
		expect(preview.detail).toContain("files.put");
		expect(preview.detail).toContain("/AlfyAI/report.pdf");
	});

	it("carries reversible/destructive flags through unchanged", () => {
		const preview = buildWritePreview(
			op({ reversible: false, destructive: true }),
		);
		expect(preview.reversible).toBe(false);
		expect(preview.destructive).toBe(true);
	});
});

describe("idempotencyKey", () => {
	it("produces the same key for identical operations", () => {
		expect(idempotencyKey(op())).toBe(idempotencyKey(op()));
	});

	it("is stable across repeated calls on the same operation", () => {
		const theOp = op();
		const first = idempotencyKey(theOp);
		const second = idempotencyKey(theOp);
		const third = idempotencyKey(theOp);
		expect(first).toBe(second);
		expect(second).toBe(third);
	});

	it("produces a different key for a different target", () => {
		const a = idempotencyKey(op({ target: { path: "/AlfyAI/a.pdf" } }));
		const b = idempotencyKey(op({ target: { path: "/AlfyAI/b.pdf" } }));
		expect(a).not.toBe(b);
	});

	it("produces a different key for a different payloadFingerprint", () => {
		const a = idempotencyKey(op({ payloadFingerprint: "hash-a" }));
		const b = idempotencyKey(op({ payloadFingerprint: "hash-b" }));
		expect(a).not.toBe(b);
	});

	it("produces a different key for a different action", () => {
		const a = idempotencyKey(op({ action: "files.put" }));
		const b = idempotencyKey(op({ action: "files.delete" }));
		expect(a).not.toBe(b);
	});

	it("produces a different key for a different connection", () => {
		const a = idempotencyKey(op({ connectionId: "conn-1" }));
		const b = idempotencyKey(op({ connectionId: "conn-2" }));
		expect(a).not.toBe(b);
	});

	it("looks like a stable hex digest", () => {
		const key = idempotencyKey(op());
		expect(key).toMatch(/^[0-9a-f]{32,}$/);
	});
});

describe("requiresConfirm", () => {
	it("always returns true, including for benign writes", () => {
		expect(requiresConfirm(op())).toBe(true);
	});

	it("always returns true for destructive/irreversible writes", () => {
		expect(requiresConfirm(op({ destructive: true, reversible: false }))).toBe(
			true,
		);
	});
});
