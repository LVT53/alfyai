import { describe, expect, it } from "vitest";
import {
	DOCUMENT_EXTRACTION_STATUSES,
	type DocumentExtractionStatus,
} from "$lib/shared/extraction-status";
import {
	canReportExtractionPhase,
	canTransitionExtractionStatus,
	EXTRACTION_STATUS_TRANSITIONS,
	isFrozenExtractionStatus,
} from "./state-machine";

describe("extraction status machine", () => {
	it("covers every status exactly once", () => {
		expect(Object.keys(EXTRACTION_STATUS_TRANSITIONS).sort()).toEqual(
			[...DOCUMENT_EXTRACTION_STATUSES].sort(),
		);
	});

	it("only ever points at real statuses", () => {
		const known = new Set<string>(DOCUMENT_EXTRACTION_STATUSES);
		for (const [from, targets] of Object.entries(
			EXTRACTION_STATUS_TRANSITIONS,
		)) {
			for (const to of targets) {
				expect(known.has(to), `${from} -> ${to}`).toBe(true);
			}
		}
	});

	it("never allows a self-transition", () => {
		// Repeating a phase is a heartbeat, not a state change; modelling it as an
		// edge would let `reportExtractionProgress` rewrite updatedAt forever
		// without anything having happened.
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			expect(canTransitionExtractionStatus(status, status), status).toBe(false);
		}
	});

	it("allows the happy path and refuses the reverse", () => {
		const ladder: DocumentExtractionStatus[] = [
			"queued",
			"uploading",
			"parsing",
			"downloading",
			"indexing",
			"succeeded",
		];
		for (let i = 0; i < ladder.length - 1; i += 1) {
			expect(
				canTransitionExtractionStatus(ladder[i], ladder[i + 1]),
				`${ladder[i]} -> ${ladder[i + 1]}`,
			).toBe(true);
			// The reverse is illegal for every PHASE pair. `active -> queued` is
			// excluded because it is not a backwards phase move but the requeue a
			// retryable failure performs, and `queued` is the first rung.
			if (i === 0) continue;
			expect(
				canTransitionExtractionStatus(ladder[i + 1], ladder[i]),
				`${ladder[i + 1]} -> ${ladder[i]}`,
			).toBe(false);
		}
	});

	it("freezes succeeded forever", () => {
		expect(isFrozenExtractionStatus("succeeded")).toBe(true);
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			expect(
				canTransitionExtractionStatus("succeeded", status),
				`succeeded -> ${status}`,
			).toBe(false);
		}
	});

	it("reopens failed and canceled only into queued", () => {
		for (const terminal of ["failed", "canceled"] as const) {
			expect(isFrozenExtractionStatus(terminal)).toBe(false);
			expect(EXTRACTION_STATUS_TRANSITIONS[terminal]).toEqual(["queued"]);
		}
	});

	it("lets any active status be canceled or fail", () => {
		for (const active of [
			"uploading",
			"parsing",
			"downloading",
			"indexing",
		] as const) {
			expect(canTransitionExtractionStatus(active, "canceled")).toBe(true);
			expect(canTransitionExtractionStatus(active, "failed")).toBe(true);
			expect(canTransitionExtractionStatus(active, "queued")).toBe(true);
		}
	});

	it("refuses to reach succeeded from anywhere but indexing", () => {
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			expect(
				canTransitionExtractionStatus(status, "succeeded"),
				`${status} -> succeeded`,
			).toBe(status === "indexing");
		}
	});

	it("treats a repeated phase report as legal, and a backwards one as not", () => {
		expect(canReportExtractionPhase("parsing", "parsing")).toBe(true);
		expect(canReportExtractionPhase("parsing", "downloading")).toBe(true);
		expect(canReportExtractionPhase("parsing", "uploading")).toBe(false);
		expect(canReportExtractionPhase("indexing", "parsing")).toBe(false);
	});
});
