import { expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { listVersions } from "../../src/lib/server/services/artifacts";
import type {
	ArtifactHistoryPage,
	ArtifactMoment,
	ArtifactMomentStep,
	MomentKind,
} from "../../src/lib/shared/artifacts/history";
import { parseRestoredVersion } from "../../src/lib/shared/artifacts/version-summaries";

/**
 * A stand-in for the history route while the server half of the versioning
 * build (ruling 76, `GET /api/artifacts/[id]/history`) was not merged yet. It
 * answers the page's real `fetch` with moments derived from the REAL version
 * rows in the e2e database (the same rows the real route reads), applying the
 * one fold rule these specs need (F1: an Undo that immediately follows the Alfy
 * change it undid). Everything the browser does with the answer, and every
 * other route (the body, the restore), is the real thing.
 *
 * Remove this file, and its `installHistoryFake` calls, once the real route is in
 * the branch: the specs then run against it unchanged.
 */

/** The seeded e2e admin's id, for reading the rows the way the route would. */
export async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

function kindOf(row: {
	versionNumber: number;
	author: "user" | "alfy";
	summary: string;
}): MomentKind {
	const { versionNumber, author, summary } = row;
	if (versionNumber === 1) {
		if (summary === "Alfy wrote the first draft") return "first_draft";
		if (summary === "Saved as a new document") return "saved_as_copy";
		if (summary === "Kept from a chat reply") return "kept_from_chat";
		return author === "alfy" ? "first_draft" : "user_edit";
	}
	if (summary === "Undid Alfy's change") return "undo_alfy_change";
	if (parseRestoredVersion(summary) !== null) return "restore";
	if (summary === "Alfy's comment reply") return "alfy_reply_edit";
	if (summary === "Edited") return "user_edit";
	return author === "alfy" ? "alfy_edit" : "user_edit";
}

export interface HistoryFake {
	/** Names given through the (also faked) naming route, by version id. */
	labels: Map<string, string>;
	/** How many times the history route was asked, and with which `before`. */
	requests: Array<{ before: number | null; limit: number | null }>;
}

/**
 * Installs the fake for one artifact on one page. `pageSize` is the route's
 * default page (50) unless a test lowers it.
 */
export async function installHistoryFake(
	page: Page,
	artifactId: string,
	options: { pageSize?: number } = {},
): Promise<HistoryFake> {
	const userId = await adminId();
	const fake: HistoryFake = { labels: new Map(), requests: [] };
	const pageSize = options.pageSize ?? 50;

	await page.route(
		new RegExp(`/api/artifacts/${artifactId}/history(\\?.*)?$`),
		async (route) => {
			const url = new URL(route.request().url());
			const before = url.searchParams.get("before");
			const limit = url.searchParams.get("limit");
			fake.requests.push({
				before: before === null ? null : Number(before),
				limit: limit === null ? null : Number(limit),
			});
			const rows = await listVersions({ userId, artifactId, limit: 5000 });
			const ordered = rows
				.slice()
				.sort((a, b) => a.versionNumber - b.versionNumber);
			const newest = ordered.at(-1);
			if (!newest) {
				await route.fulfill({
					status: 404,
					json: { ok: false, reason: "not_found" },
				});
				return;
			}
			const idOf = new Map(ordered.map((row) => [row.versionNumber, row.id]));

			// One moment per row, oldest first, folding an Undo onto the change before it.
			const moments: ArtifactMoment[] = [];
			for (const row of ordered) {
				const kind = kindOf(row);
				const previousRow = ordered.find(
					(candidate) => candidate.versionNumber === row.versionNumber - 1,
				);
				const base = (
					rowKind: MomentKind,
					source: typeof row,
				): Omit<ArtifactMomentStep, "isNewest" | "sameAsNow" | "sameAs"> => ({
					versionId: source.id,
					versionNumber: source.versionNumber,
					kind: rowKind,
					author: source.author,
					at: source.createdAt,
					text: null,
					label: fake.labels.get(source.id) ?? null,
					parentVersionId: idOf.get(source.versionNumber - 1) ?? null,
					parentVersionNumber:
						source.versionNumber > 1 ? source.versionNumber - 1 : null,
				});
				const last = moments.at(-1);
				if (
					kind === "undo_alfy_change" &&
					last &&
					last.kind === "alfy_edit" &&
					last.fold === null &&
					last.steps.length === 0 &&
					previousRow &&
					last.versionNumber === previousRow.versionNumber
				) {
					last.fold = "undone";
					last.status = "undone";
					last.steps.push({
						...base(kind, row),
						isNewest: row.versionNumber === newest.versionNumber,
						sameAsNow: false,
						sameAs: null,
					});
					last.containsNewest = row.versionNumber === newest.versionNumber;
					continue;
				}
				const restoredFromNumber = parseRestoredVersion(row.summary);
				const restoredFromRow =
					restoredFromNumber === null
						? undefined
						: ordered.find((c) => c.versionNumber === restoredFromNumber);
				moments.push({
					...base(kind, row),
					fold: null,
					quiet: false,
					startedAt: null,
					text:
						kind === "alfy_edit" && row.summary !== "Alfy's edit"
							? row.summary
							: null,
					tick: null,
					target: null,
					restoredFrom: restoredFromRow
						? {
								versionId: restoredFromRow.id,
								versionNumber: restoredFromRow.versionNumber,
								at: restoredFromRow.createdAt,
							}
						: null,
					commentId: null,
					detail: { type: "none" },
					status: null,
					undoneBy: null,
					isNewest: row.versionNumber === newest.versionNumber,
					containsNewest: row.versionNumber === newest.versionNumber,
					sameAsNow: false,
					sameAs: null,
					restoredHere: [],
					bodyHash: `fake-${row.versionNumber}`,
					steps: [],
				});
			}
			// A restore says where it came from, on the source moment.
			for (const moment of moments) {
				if (moment.kind !== "restore" || !moment.restoredFrom) continue;
				const source = moments.find(
					(candidate) => candidate.versionId === moment.restoredFrom?.versionId,
				);
				source?.restoredHere.unshift({
					versionId: moment.versionId,
					versionNumber: moment.versionNumber,
					at: moment.at,
				});
			}

			const newestFirst = moments.slice().reverse();
			const start =
				before === null
					? 0
					: newestFirst.findIndex(
							(moment) => moment.versionNumber < Number(before),
						);
			const slice =
				start === -1
					? []
					: newestFirst.slice(
							start,
							start + (limit === null ? pageSize : Number(limit)),
						);
			const lastShown = slice.at(-1);
			const older =
				lastShown !== undefined &&
				newestFirst.indexOf(lastShown) < newestFirst.length - 1;
			const body: ArtifactHistoryPage = {
				ok: true,
				artifactKind: "document",
				moments: slice,
				older,
				nextBefore: older && lastShown ? lastShown.versionNumber : null,
				newestVersion: newest.versionNumber,
			};
			await route.fulfill({ json: body });
		},
	);

	await page.route(
		new RegExp(`/api/artifacts/${artifactId}/versions/[^/?]+(\\?.*)?$`),
		async (route) => {
			if (route.request().method() !== "PATCH") {
				await route.fallback();
				return;
			}
			const versionId = new URL(route.request().url()).pathname
				.split("/")
				.at(-1) as string;
			const { label } = route.request().postDataJSON() as {
				label: string | null;
			};
			if (label?.trim()) fake.labels.set(versionId, label.trim());
			else fake.labels.delete(versionId);
			await route.fulfill({
				json: { ok: true, label: fake.labels.get(versionId) ?? null },
			});
		},
	);
	return fake;
}
