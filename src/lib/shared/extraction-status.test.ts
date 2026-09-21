import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DOCUMENT_EXTRACTION_ACTIVE_STATUSES,
	DOCUMENT_EXTRACTION_STATUSES,
	DOCUMENT_EXTRACTION_TERMINAL_STATUSES,
	EXTRACTION_ERROR_CODES,
	isActiveExtractionStatus,
	isDocumentExtractionStatus,
	isExtractionErrorCode,
	isLegacyExtractionJobId,
	isRetryableExtractionErrorCode,
	isTerminalExtractionStatus,
	LEGACY_EXTRACTION_JOB_ID_PREFIX,
	legacyExtractionJobId,
	RETRYABLE_EXTRACTION_ERROR_CODES,
} from "./extraction-status";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../..");

function read(relative: string): string {
	return readFileSync(path.join(src, relative), "utf8");
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("document extraction statuses", () => {
	it("partitions cleanly into queued, active and terminal", () => {
		const active = new Set<string>(DOCUMENT_EXTRACTION_ACTIVE_STATUSES);
		const terminal = new Set<string>(DOCUMENT_EXTRACTION_TERMINAL_STATUSES);

		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			const memberships = [
				status === "queued",
				active.has(status),
				terminal.has(status),
			].filter(Boolean);
			expect(memberships, status).toHaveLength(1);
		}

		expect(active.size + terminal.size + 1).toBe(
			DOCUMENT_EXTRACTION_STATUSES.length,
		);
	});

	it("agrees with its own predicates", () => {
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			expect(isTerminalExtractionStatus(status)).toBe(
				(DOCUMENT_EXTRACTION_TERMINAL_STATUSES as readonly string[]).includes(
					status,
				),
			);
			expect(isActiveExtractionStatus(status)).toBe(
				(DOCUMENT_EXTRACTION_ACTIVE_STATUSES as readonly string[]).includes(
					status,
				),
			);
			expect(isDocumentExtractionStatus(status)).toBe(true);
		}
		expect(isDocumentExtractionStatus("cancelled")).toBe(false);
		expect(isDocumentExtractionStatus(7)).toBe(false);
	});
});

describe("extraction error codes", () => {
	it("marks exactly the transient codes retryable", () => {
		const retryable = EXTRACTION_ERROR_CODES.filter((code) =>
			isRetryableExtractionErrorCode(code),
		);
		expect([...retryable].sort()).toEqual(
			[...RETRYABLE_EXTRACTION_ERROR_CODES].sort(),
		);
	});

	it("keeps the admin-fixable codes off the retry path", () => {
		// Retrying a wrong API key or an unavailable tier burns three attempts
		// plus backoff on a fault no retry can fix, and delays the only message
		// that actually helps.
		for (const code of [
			"auth_failed",
			"tier_unavailable",
			"too_large",
			"unsupported_type",
			"document_unreadable",
			"empty_result",
			"canceled",
			"max_attempts",
			"internal",
			"legacy_unknown",
		] as const) {
			expect(isRetryableExtractionErrorCode(code), code).toBe(false);
		}
	});

	it("recognises its own codes and nothing else", () => {
		expect(isExtractionErrorCode("job_failed")).toBe(true);
		expect(isExtractionErrorCode("cancelled")).toBe(false);
		expect(isExtractionErrorCode(null)).toBe(false);
	});
});

describe("legacy job ids", () => {
	it("round-trips the synthetic id prefix", () => {
		const id = legacyExtractionJobId("artifact-1");
		expect(id).toBe(`${LEGACY_EXTRACTION_JOB_ID_PREFIX}artifact-1`);
		expect(isLegacyExtractionJobId(id)).toBe(true);
		expect(isLegacyExtractionJobId("artifact-1")).toBe(false);
	});
});

describe("module hygiene", () => {
	// The same zero-value-import guard the shared file-type table carries: this
	// module is reached from Svelte components, server services and routes
	// alike, so anything it imported would travel to all three.
	it("has no value imports", () => {
		const source = read("lib/shared/extraction-status.ts");
		expect(source.match(/^import\s(?!type)/gm)).toBeNull();
	});

	// Two spellings of the same idea in one codebase invite a "cleanup" that
	// silently renames a stored status string. Pin both directions.
	it("spells canceled with one l, while file production keeps two", () => {
		// Comments are stripped first: both files explain the divergence in prose
		// and would otherwise fail their own assertion. What must not drift is
		// the CODE — the status strings themselves.
		const extraction = stripComments(read("lib/shared/extraction-status.ts"));
		expect(extraction).toContain('"canceled"');
		expect(extraction).not.toMatch(/cancelled/);

		const fileProduction = stripComments(
			read("lib/server/services/file-production/types.ts"),
		);
		expect(fileProduction).toContain('"cancelled"');
		expect(fileProduction).not.toMatch(/(?<!l)"canceled"/);
	});
});
