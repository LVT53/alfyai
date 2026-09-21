import { describe, expect, it } from "vitest";
import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
} from "$lib/shared/extraction-status";
import {
	DOCUMENT_EXTRACTION_STATUSES,
	EXTRACTION_ERROR_CODES,
	isTerminalExtractionStatus,
} from "$lib/shared/extraction-status";
import type { KnowledgeDocumentItem } from "./documents-table";
import {
	canCancelExtraction,
	canOpenDocument,
	canRetryExtraction,
	compareDocuments,
	DOCUMENT_COLUMN_ORDER,
	deriveDocumentStatus,
	deriveDocumentVersion,
	documentVersionRank,
	extractionDetailKey,
	extractionErrorKey,
	extractionStatusKey,
	getDocumentKind,
	hasNormalisedVersion,
	isExtractionInProgress,
	nextSortDirection,
	sortDocuments,
} from "./documents-table";

function job(
	overrides: Partial<DocumentExtractionJobDTO> & {
		status: DocumentExtractionStatus;
	},
): DocumentExtractionJobDTO {
	return {
		id: "job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		intakeRoute: "mineru",
		fileName: "report.pdf",
		attemptCount: 1,
		maxAttempts: 3,
		retryable: false,
		cancelable: false,
		error: null,
		createdAt: 1_700_000_000,
		updatedAt: 1_700_000_000,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

function doc(
	overrides: Partial<KnowledgeDocumentItem> & { id: string; name: string },
): KnowledgeDocumentItem {
	return {
		type: "source_document",
		displayArtifactId: `artifact-${overrides.id}`,
		promptArtifactId: null,
		familyArtifactIds: [],
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: null,
		summary: null,
		normalizedAvailable: false,
		createdAt: 1_700_000_000,
		updatedAt: 1_700_000_000,
		...overrides,
	};
}

describe("DOCUMENT_COLUMN_ORDER", () => {
	it("puts the name first and version, type and status after it", () => {
		expect(DOCUMENT_COLUMN_ORDER).toEqual([
			"name",
			"version",
			"type",
			"status",
			"size",
			"date",
			"actions",
		]);
	});
});

describe("deriveDocumentVersion", () => {
	it("marks the first member of a family as Original", () => {
		const version = deriveDocumentVersion(
			doc({
				id: "1",
				name: "invoice.pdf",
				isOriginal: true,
				documentFamilyId: "family-1",
				versionNumber: 1,
			}),
		);
		expect(version).toEqual({ kind: "original" });
	});

	it("numbers a later member of a family", () => {
		const version = deriveDocumentVersion(
			doc({
				id: "2",
				name: "report.pdf",
				documentFamilyId: "family-1",
				versionNumber: 3,
			}),
		);
		expect(version).toEqual({ kind: "version", versionNumber: 3 });
	});

	it("shows nothing for a document with no family", () => {
		expect(deriveDocumentVersion(doc({ id: "3", name: "audit.csv" }))).toEqual({
			kind: "none",
		});
	});

	it("shows nothing for a version number with no family to belong to", () => {
		expect(
			deriveDocumentVersion(
				doc({ id: "4", name: "stray.pdf", versionNumber: 2 }),
			),
		).toEqual({ kind: "none" });
	});
});

describe("deriveDocumentStatus", () => {
	it("is blank when the document has no version family", () => {
		expect(
			deriveDocumentStatus(doc({ id: "1", name: "audit.csv" })),
		).toBeNull();
	});

	it("is blank when the family id is explicitly null", () => {
		expect(
			deriveDocumentStatus(
				doc({
					id: "1",
					name: "audit.csv",
					documentFamilyId: null,
					documentFamilyStatus: "active",
				}),
			),
		).toBeNull();
	});

	it("is Historical for a superseded member of a family", () => {
		expect(
			deriveDocumentStatus(
				doc({
					id: "2",
					name: "report-08.pdf",
					documentFamilyId: "family-1",
					documentFamilyStatus: "historical",
				}),
			),
		).toEqual({ kind: "family", value: "historical" });
	});

	it("is Current for a live member of a family", () => {
		expect(
			deriveDocumentStatus(
				doc({
					id: "3",
					name: "report-09.pdf",
					documentFamilyId: "family-1",
					documentFamilyStatus: "active",
				}),
			),
		).toEqual({ kind: "family", value: "current" });
	});

	it("defaults a family member with no status to Current", () => {
		expect(
			deriveDocumentStatus(
				doc({ id: "4", name: "report.pdf", documentFamilyId: "family-1" }),
			),
		).toEqual({ kind: "family", value: "current" });
	});
});

describe("deriveDocumentStatus with an extraction verdict", () => {
	it("puts the extraction state ahead of the version status", () => {
		// A half-read document is not "Current" against its siblings — it is
		// not yet comparable to them at all.
		const badge = deriveDocumentStatus(
			doc({
				id: "1",
				name: "report.pdf",
				documentFamilyId: "family-1",
				documentFamilyStatus: "active",
				extraction: job({ status: "parsing" }),
			}),
		);

		expect(badge).toEqual({
			kind: "extraction",
			job: expect.objectContaining({ status: "parsing" }),
		});
	});

	it("falls back to the version status once extraction succeeded", () => {
		// "Ready" on every readable row would say nothing, so a succeeded job
		// is deliberately invisible in this column.
		expect(
			deriveDocumentStatus(
				doc({
					id: "1",
					name: "report.pdf",
					documentFamilyId: "family-1",
					documentFamilyStatus: "historical",
					extraction: job({ status: "succeeded" }),
				}),
			),
		).toEqual({ kind: "family", value: "historical" });
	});

	it("is blank for a succeeded document with no version family", () => {
		expect(
			deriveDocumentStatus(
				doc({
					id: "1",
					name: "report.pdf",
					extraction: job({ status: "succeeded" }),
				}),
			),
		).toBeNull();
	});

	it("reports failed and canceled documents even without a family", () => {
		for (const status of ["failed", "canceled"] as const) {
			expect(
				deriveDocumentStatus(
					doc({ id: "1", name: "report.pdf", extraction: job({ status }) }),
				),
			).toMatchObject({ kind: "extraction" });
		}
	});
});

describe("extraction row affordances", () => {
	it("blocks opening a document the reader has not finished with", () => {
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			const document = doc({
				id: "1",
				name: "report.pdf",
				extraction: job({ status }),
			});
			expect(canOpenDocument(document)).toBe(
				isTerminalExtractionStatus(status),
			);
			expect(isExtractionInProgress(document)).toBe(
				!isTerminalExtractionStatus(status),
			);
		}
	});

	it("leaves a pre-ledger document openable when it has no verdict at all", () => {
		const document = doc({ id: "1", name: "report.pdf" });
		expect(canOpenDocument(document)).toBe(true);
		expect(isExtractionInProgress(document)).toBe(false);
	});

	it("offers Retry and Cancel exactly when the DTO says so", () => {
		expect(
			canRetryExtraction(
				doc({
					id: "1",
					name: "a.pdf",
					extraction: job({ status: "failed", retryable: true }),
				}),
			),
		).toBe(true);
		expect(
			canRetryExtraction(
				doc({
					id: "2",
					name: "b.pdf",
					extraction: job({ status: "failed", retryable: false }),
				}),
			),
		).toBe(false);
		expect(
			canCancelExtraction(
				doc({
					id: "3",
					name: "c.pdf",
					extraction: job({ status: "parsing", cancelable: true }),
				}),
			),
		).toBe(true);
		expect(
			canCancelExtraction(
				doc({
					id: "4",
					name: "d.pdf",
					extraction: job({ status: "parsing", cancelable: false }),
				}),
			),
		).toBe(false);
	});
});

describe("extraction i18n keys", () => {
	it("names a dictionary key for every status", () => {
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			expect(extractionStatusKey(status)).toBe(
				`knowledge.extraction.status.${status}`,
			);
		}
	});

	it("names a dictionary key for every error code", () => {
		for (const code of EXTRACTION_ERROR_CODES) {
			expect(extractionErrorKey(code)).toBe(
				`knowledge.extraction.error.${code}`,
			);
		}
	});

	it("has no detail line while a job is still running", () => {
		expect(extractionDetailKey(job({ status: "parsing" }))).toBeNull();
		expect(extractionDetailKey(job({ status: "succeeded" }))).toBeNull();
		expect(extractionDetailKey(job({ status: "queued" }))).toBeNull();
	});

	// Ruling 1: the one non-terminal state that owes the user an explanation.
	// "Queued", for half an hour, looks like a stuck app.
	it("explains a queued job that is waiting for an unreachable backend", () => {
		expect(
			extractionDetailKey(
				job({
					status: "queued",
					error: { code: "unavailable", message: "unreachable" },
					nextAttemptAt: 60_000,
				}),
			),
		).toBe("knowledge.extraction.status.waitingForBackend");

		// A document failure waiting out its own backoff is not an outage.
		expect(
			extractionDetailKey(
				job({
					status: "queued",
					error: { code: "job_failed", message: "engine failed" },
				}),
			),
		).toBeNull();
	});

	it("explains a failure by its code, and a code-less failure generically", () => {
		expect(
			extractionDetailKey(
				job({
					status: "failed",
					error: { code: "too_large", message: "too big" },
				}),
			),
		).toBe("knowledge.extraction.error.too_large");
		expect(extractionDetailKey(job({ status: "failed" }))).toBe(
			"knowledge.extraction.error.internal",
		);
		expect(extractionDetailKey(job({ status: "canceled" }))).toBe(
			"knowledge.extraction.error.canceled",
		);
	});
});

describe("getDocumentKind", () => {
	it("reads skill notes from either the origin or the artifact type", () => {
		expect(
			getDocumentKind(
				doc({ id: "1", name: "tone.md", documentOrigin: "skill_note" }),
			),
		).toBe("skill_note");
		expect(
			getDocumentKind(doc({ id: "2", name: "tone.md", type: "skill_note" })),
		).toBe("skill_note");
	});

	it("reads generated output from either the origin or the artifact type", () => {
		expect(
			getDocumentKind(
				doc({ id: "3", name: "atlas.pdf", documentOrigin: "generated" }),
			),
		).toBe("generated");
		expect(
			getDocumentKind(
				doc({ id: "4", name: "atlas.pdf", type: "generated_output" }),
			),
		).toBe("generated");
	});

	it("falls back to uploaded", () => {
		expect(getDocumentKind(doc({ id: "5", name: "invoice.pdf" }))).toBe(
			"uploaded",
		);
	});
});

describe("hasNormalisedVersion", () => {
	it("is true only when both the flag and the artifact are present", () => {
		expect(
			hasNormalisedVersion(
				doc({
					id: "1",
					name: "a.pdf",
					normalizedAvailable: true,
					promptArtifactId: "prompt-1",
				}),
			),
		).toBe(true);
		expect(
			hasNormalisedVersion(
				doc({ id: "2", name: "b.pdf", normalizedAvailable: true }),
			),
		).toBe(false);
		expect(
			hasNormalisedVersion(
				doc({ id: "3", name: "c.csv", promptArtifactId: "prompt-3" }),
			),
		).toBe(false);
	});
});

describe("documentVersionRank", () => {
	it("ranks Original below v1 and an unversioned row below both", () => {
		const original = doc({
			id: "1",
			name: "a",
			isOriginal: true,
			documentFamilyId: "f",
		});
		const v1 = doc({
			id: "2",
			name: "b",
			documentFamilyId: "f",
			versionNumber: 1,
		});
		const none = doc({ id: "3", name: "c" });
		expect(documentVersionRank(none)).toBeLessThan(
			documentVersionRank(original),
		);
		expect(documentVersionRank(original)).toBeLessThan(documentVersionRank(v1));
	});
});

describe("compareDocuments / sortDocuments", () => {
	const alpha = doc({
		id: "a",
		name: "alpha.pdf",
		sizeBytes: 300,
		createdAt: 300,
	});
	const beta = doc({
		id: "b",
		name: "beta.pdf",
		sizeBytes: 100,
		createdAt: 100,
		documentOrigin: "generated",
	});
	const gamma = doc({
		id: "c",
		name: "gamma.pdf",
		sizeBytes: 200,
		createdAt: 200,
		documentOrigin: "skill_note",
	});
	const all = [beta, gamma, alpha];

	it("sorts by name in both directions", () => {
		expect(sortDocuments(all, "name", "asc").map((d) => d.id)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(sortDocuments(all, "name", "desc").map((d) => d.id)).toEqual([
			"c",
			"b",
			"a",
		]);
	});

	it("sorts by size", () => {
		expect(sortDocuments(all, "size", "desc").map((d) => d.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("sorts by date newest first when descending", () => {
		expect(sortDocuments(all, "date", "desc").map((d) => d.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("sorts by type using the derived kind, not the mime type", () => {
		// generated < skill_note < uploaded, alphabetically.
		expect(sortDocuments(all, "type", "asc").map((d) => d.id)).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	it("sorts by version with unversioned rows last when descending", () => {
		const original = doc({
			id: "o",
			name: "o.pdf",
			isOriginal: true,
			documentFamilyId: "f",
		});
		const v3 = doc({
			id: "v3",
			name: "v3.pdf",
			documentFamilyId: "f",
			versionNumber: 3,
		});
		const plain = doc({ id: "p", name: "p.pdf" });
		expect(
			sortDocuments([original, plain, v3], "version", "desc").map((d) => d.id),
		).toEqual(["v3", "o", "p"]);
	});

	it("breaks ties deterministically by name", () => {
		const left = doc({ id: "z", name: "same.pdf", sizeBytes: 10 });
		const right = doc({ id: "a", name: "other.pdf", sizeBytes: 10 });
		expect(compareDocuments(left, right, "size", "asc")).toBeGreaterThan(0);
		expect(
			sortDocuments([left, right], "size", "asc").map((d) => d.id),
		).toEqual(["a", "z"]);
	});

	it("does not mutate the array it is given", () => {
		const input = [...all];
		sortDocuments(input, "name", "asc");
		expect(input.map((d) => d.id)).toEqual(["b", "c", "a"]);
	});
});

describe("nextSortDirection", () => {
	it("flips the direction of the column already sorted", () => {
		expect(nextSortDirection("date", "desc", "date")).toBe("asc");
		expect(nextSortDirection("date", "asc", "date")).toBe("desc");
	});

	it("opens text columns ascending and everything else descending", () => {
		expect(nextSortDirection("date", "desc", "name")).toBe("asc");
		expect(nextSortDirection("date", "desc", "type")).toBe("asc");
		expect(nextSortDirection("name", "asc", "size")).toBe("desc");
		expect(nextSortDirection("name", "asc", "version")).toBe("desc");
		expect(nextSortDirection("name", "asc", "date")).toBe("desc");
	});
});
