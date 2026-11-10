import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { isValidTimeZone } from "$lib/shared/time-zone";

/**
 * The person's stored IANA zone, for this turn's clock
 * (normal-chat-context.ts's buildTimeContextLine), or null: no browser has
 * saved one yet, the stored name is one this runtime no longer reads, or the
 * read failed. Null is a clock that keeps the server's date and says the zone is
 * unknown, so the zone is an auxiliary read: it never fails a turn.
 *
 * One read per turn, resolved by the caller and handed to prompt assembly as
 * data (prompt assembly renders it and never reads for it). Nothing is cached
 * between turns, so a zone changed in Settings, or saved by a browser that
 * moved, is the next turn's clock.
 */
export async function resolveTurnTimeZone(
	userId: string,
): Promise<string | null> {
	try {
		const [row] = await db
			.select({ timeZone: users.timeZone })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		return isValidTimeZone(row?.timeZone) ? row.timeZone : null;
	} catch (error) {
		console.warn("[NORMAL_CHAT_CONTEXT] Time zone read skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
