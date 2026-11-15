// One clip plays at a time (video plan, slice 3). A player claims playback
// when it starts and lets go when it pauses or unmounts; claiming pauses every
// other player that still holds it. Module-level and tiny: the rule belongs to
// the players, not to the chat page, so it holds in the card, the panel and any
// two players mounted side by side.
export type ClipPlayback = { pause: () => void };

const playing = new Set<ClipPlayback>();

/** Starts `owner`, pausing every other clip that is still playing. */
export function claimPlayback(owner: ClipPlayback): void {
	for (const other of playing) {
		if (other !== owner) other.pause();
	}
	playing.add(owner);
}

/** Lets go of playback (a pause, or the player leaving the page). */
export function releasePlayback(owner: ClipPlayback): void {
	playing.delete(owner);
}
