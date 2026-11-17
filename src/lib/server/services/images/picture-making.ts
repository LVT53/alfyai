// Whether Alfy may make pictures and videos in a person's chats: their own
// "Pictures and videos" switch (Settings > Profile, `users.pictures_and_videos_enabled`),
// on by default. Off means the turn is not offered make_image or make_video and
// its guidance says so (chat-turn/normal-chat-tool-gating.ts,
// normal-chat-context.ts's PICTURES_AND_VIDEOS_OFF_GUIDANCE). It is the person's
// own: nothing reads another person's switch, and no admin setting sets it.
//
// Fails open to the default, as the memory gate does: a read that fails or a
// person who cannot be found keeps what every account had before the switch.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";

export async function isPictureMakingOnFor(userId: string): Promise<boolean> {
	try {
		const [row] = await db
			.select({ on: users.picturesAndVideosEnabled })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		return row?.on !== false;
	} catch (error) {
		console.warn("[IMAGES] The Pictures and videos switch could not be read", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return true;
	}
}
