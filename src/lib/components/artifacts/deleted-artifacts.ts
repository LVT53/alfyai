/**
 * What the chat's cards need to know about items that were deleted (polish
 * G2-A), as ONE value so it travels the message → block → row prop chain as a
 * single prop instead of four: which items are gone, which are being made
 * again, which cannot be, and the Regenerate action itself. The chat page owns
 * the state; a card only reads it.
 */
export interface DeletedArtifacts {
	/** Ids of the items this chat's cards point at that no longer exist. */
	readonly deletedIds: readonly string[];
	/** Ids being made again right now. */
	readonly regeneratingIds: readonly string[];
	/** Ids the server said have nothing left to be made again from. */
	readonly unavailableIds: readonly string[];
	/** Regenerate, by the deleted item's id. */
	readonly onRegenerate: (artifactId: string) => void;
}
