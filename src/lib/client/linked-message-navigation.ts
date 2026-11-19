/** Loads authorized older windows until the requested message is present.
 * Navigation changes and a non-advancing page stop the walk without scrolling. */
export async function loadLinkedMessage(options: {
	targetId: string;
	isCurrent: () => boolean;
	messageIds: () => string[];
	hasMore: () => boolean;
	loadOlder: () => Promise<void>;
}): Promise<"found" | "unavailable" | "cancelled" | "retryable"> {
	while (options.isCurrent()) {
		const before = options.messageIds();
		if (before.includes(options.targetId)) return "found";
		if (!options.hasMore()) return "unavailable";
		try {
			await options.loadOlder();
		} catch {
			return options.isCurrent() ? "retryable" : "cancelled";
		}
		if (!options.isCurrent()) return "cancelled";
		const after = options.messageIds();
		if (after.includes(options.targetId)) return "found";
		if (after.length <= before.length)
			return options.hasMore() ? "retryable" : "unavailable";
	}
	return "cancelled";
}
