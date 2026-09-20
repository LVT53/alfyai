import { describe, expect, it } from "vitest";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { createExtractionAnnouncer } from "./extraction-announcements";

function job(
	overrides: Partial<DocumentExtractionJobDTO> & { sourceArtifactId: string },
): DocumentExtractionJobDTO {
	return {
		id: `job-${overrides.sourceArtifactId}`,
		normalizedArtifactId: null,
		status: "queued",
		intakeRoute: "mineru",
		fileName: "doc.pdf",
		attemptCount: 1,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 0,
		updatedAt: 0,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

function row(artifactId: string, overrides: Partial<DocumentExtractionJobDTO>) {
	return {
		artifactId,
		name: `${artifactId}.pdf`,
		job: { ...job({ sourceArtifactId: artifactId }), ...overrides },
	};
}

describe("createExtractionAnnouncer", () => {
	it("says nothing about a document it is seeing for the first time", () => {
		const announcer = createExtractionAnnouncer();
		// The surface drew these rows; the user can see them. Announcing their
		// current state would be reading the screen back at them.
		expect(announcer.changed([row("a", {}), row("b", {})])).toEqual([]);
	});

	it("announces once per real change, not once per poll", () => {
		const announcer = createExtractionAnnouncer();
		announcer.changed([row("a", { status: "queued" })]);

		expect(
			announcer
				.changed([row("a", { status: "parsing" })])
				.map((r) => r.artifactId),
		).toEqual(["a"]);
		// Four more polls with the same verdict say nothing.
		for (let poll = 0; poll < 4; poll += 1) {
			expect(announcer.changed([row("a", { status: "parsing" })])).toEqual([]);
		}
		expect(
			announcer
				.changed([row("a", { status: "succeeded" })])
				.map((r) => r.artifactId),
		).toEqual(["a"]);
	});

	it("notices a failure that becomes a different failure", () => {
		const announcer = createExtractionAnnouncer();
		announcer.changed([
			row("a", {
				status: "failed",
				retryable: true,
				error: { code: "unavailable", message: "" },
			}),
		]);

		// Same status, different cause and no longer retryable: the row now says
		// something else and offers a different button.
		expect(
			announcer.changed([
				row("a", {
					status: "failed",
					retryable: false,
					error: { code: "max_attempts", message: "" },
				}),
			]),
		).toHaveLength(1);
	});

	it("reports a whole batch at once so several uploads are one announcement", () => {
		const announcer = createExtractionAnnouncer();
		const ids = ["a", "b", "c"];
		announcer.changed(ids.map((id) => row(id, { status: "queued" })));

		const changed = announcer.changed(
			ids.map((id) => row(id, { status: "parsing" })),
		);
		expect(changed.map((entry) => entry.artifactId)).toEqual(ids);
	});

	it("forgets a document the caller stopped tracking", () => {
		const announcer = createExtractionAnnouncer();
		announcer.changed([row("a", { status: "parsing" })]);
		announcer.changed([]);

		// Back as a first sighting, not as a change from a state nobody is
		// looking at any more.
		expect(announcer.changed([row("a", { status: "succeeded" })])).toEqual([]);
	});

	it("starts over on reset", () => {
		const announcer = createExtractionAnnouncer();
		announcer.changed([row("a", { status: "parsing" })]);
		announcer.reset();
		expect(announcer.changed([row("a", { status: "succeeded" })])).toEqual([]);
	});
});
