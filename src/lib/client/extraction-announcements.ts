// One announcement per real state change, per document.
//
// The poller answers every second while anything is unsettled, and it hands
// back a fresh DTO object each time. A live region bound straight to that
// would say "Budget.pdf: reading" to a screen-reader user once a second for
// as long as the read takes, which is worse than saying nothing at all —
// the region becomes noise the user learns to ignore, and the one
// announcement that mattered ("Budget.pdf could not be read") is lost in it.
//
// This remembers the state last announced per artifact and reports only the
// rows that actually moved. The FIRST sighting of a document is never
// announced: it is the state the surface drew it in, which the user can
// already see, so a batch of five uploads appearing at once says nothing and
// then speaks once per transition — not five times, because the caller turns
// the whole batch into one live-region string.
//
// Pure and framework-free, shared by the composer chips and the Knowledge
// list so the two cannot drift into different ideas of "changed".

import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";

export interface ExtractionAnnouncementRow {
	artifactId: string;
	name: string;
	job: DocumentExtractionJobDTO;
}

export interface ExtractionAnnouncer {
	/**
	 * The rows whose state moved since the last call, in the order given.
	 * Rows absent from `rows` are forgotten, so a document removed and added
	 * again is a first sighting rather than a spurious change.
	 */
	changed(
		rows: readonly ExtractionAnnouncementRow[],
	): ExtractionAnnouncementRow[];
	/** Forget everything, e.g. when the composer is cleared after a send. */
	reset(): void;
}

/**
 * What a user would notice. The status alone is not enough: a failure that
 * becomes a DIFFERENT failure, or one that stops being retryable, changes
 * what the row says and what buttons it offers.
 */
function announcementSignature(job: DocumentExtractionJobDTO): string {
	return `${job.status}|${job.error?.code ?? ""}|${job.retryable ? "1" : "0"}`;
}

export function createExtractionAnnouncer(): ExtractionAnnouncer {
	const announced = new Map<string, string>();

	return {
		changed(rows) {
			const seen = new Set<string>();
			const changed: ExtractionAnnouncementRow[] = [];

			for (const row of rows) {
				seen.add(row.artifactId);
				const next = announcementSignature(row.job);
				const previous = announced.get(row.artifactId);
				if (previous === next) continue;
				announced.set(row.artifactId, next);
				if (previous === undefined) continue;
				changed.push(row);
			}

			for (const artifactId of announced.keys()) {
				if (!seen.has(artifactId)) announced.delete(artifactId);
			}

			return changed;
		},
		reset() {
			announced.clear();
		},
	};
}
