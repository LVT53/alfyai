import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { selectInBatches } from "$lib/server/db/id-batches";
import { imageDescriptions } from "$lib/server/db/schema";

// What a picture shows, in a few words, kept for the turns after the one that
// sent its pixels (vision/AGENTS.md). One row per artifact, written once: the
// description is of the image alone, never of the chat it was attached in.

/**
 * The stored descriptions of some pictures, by artifact id. A picture with none
 * (not described yet, or the describing failed) is absent from the map, and the
 * caller falls back to its file name. Only the person's own rows are read.
 */
export async function getImageDescriptions(
	userId: string,
	artifactIds: readonly string[],
): Promise<Map<string, string>> {
	const rows = await selectInBatches([...new Set(artifactIds)], (batch) =>
		db
			.select({
				artifactId: imageDescriptions.artifactId,
				description: imageDescriptions.description,
			})
			.from(imageDescriptions)
			.where(
				and(
					eq(imageDescriptions.userId, userId),
					inArray(imageDescriptions.artifactId, batch),
				),
			),
	);
	return new Map(rows.map((row) => [row.artifactId, row.description]));
}

/**
 * Keeps the description of a picture, once: a second save for the same
 * artifact (the same photo described by two turns at once) changes nothing, so
 * the first description stands. An artifact that is gone throws, since the
 * database refuses a row that points at nothing; the describer logs that.
 */
export async function saveImageDescription(params: {
	userId: string;
	artifactId: string;
	description: string;
	modelName: string;
}): Promise<void> {
	await db
		.insert(imageDescriptions)
		.values({
			artifactId: params.artifactId,
			userId: params.userId,
			description: params.description,
			modelName: params.modelName,
		})
		.onConflictDoNothing();
}
