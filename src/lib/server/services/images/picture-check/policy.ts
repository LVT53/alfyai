// Whose pictures the explicit-picture filter checks. On for everyone unless an
// admin turns it off for the install (IMAGE_EXPLICIT_FILTER_ENABLED, read
// through config-store) or exempts one person (`users.explicit_picture_filter_exempt`,
// set in the Users pane). Incognito chats follow the same rule.
//
// Fails closed: a person who cannot be read is checked.

import { eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";

export async function isExplicitFilterOnFor(userId: string): Promise<boolean> {
	if (!getConfig().imageExplicitFilterEnabled) return false;
	try {
		const [row] = await db
			.select({ exempt: users.explicitPictureFilterExempt })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		return row?.exempt !== true;
	} catch (error) {
		console.warn("[IMAGES] The picture filter could not read the person", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}
