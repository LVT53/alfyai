/**
 * The rules of a sidebar selection, as pure functions: no Svelte, no stores.
 * `ConversationList` owns the selection and calls these on every change; every
 * function returns a new set and leaves the one it was given alone, because the
 * list keeps its selection in state and a set changed in place is not a change.
 */

/**
 * What the sidebar shows: for each section whether it is expanded, and the ids
 * of its chat rows from top to bottom (the folders in folder order).
 */
export type ShownSections = {
	pinned: { expanded: boolean; ids: readonly string[] };
	projects: {
		expanded: boolean;
		folders: readonly { expanded: boolean; ids: readonly string[] }[];
	};
	chats: { expanded: boolean; ids: readonly string[] };
};

/**
 * The chats on screen, in the order the sidebar draws them: Pinned, then each
 * expanded folder, then Chats. A collapsed section, and a collapsed folder, adds
 * none: a range, Select all and a bulk action never reach a chat the person
 * cannot see.
 */
export function shownConversationOrder(sections: ShownSections): string[] {
	const { pinned, projects, chats } = sections;
	return [
		...(pinned.expanded ? pinned.ids : []),
		...(projects.expanded
			? projects.folders.flatMap((folder) =>
					folder.expanded ? folder.ids : [],
				)
			: []),
		...(chats.expanded ? chats.ids : []),
	];
}

/** Adds the chat when it is not selected and takes it out when it is. */
export function toggleSelected(
	selected: ReadonlySet<string>,
	id: string,
): Set<string> {
	const next = new Set(selected);
	if (!next.delete(id)) next.add(id);
	return next;
}

/**
 * Adds every chat between the anchor and the target, both included, in either
 * direction, and keeps what was already selected. With no anchor, or when the
 * anchor or the target is not in `order`, it adds only the target.
 */
export function selectRange(
	selected: ReadonlySet<string>,
	order: readonly string[],
	anchorId: string | null,
	targetId: string,
): Set<string> {
	const next = new Set(selected);
	const anchorIndex = anchorId === null ? -1 : order.indexOf(anchorId);
	const targetIndex = order.indexOf(targetId);
	if (anchorIndex === -1 || targetIndex === -1) {
		next.add(targetId);
		return next;
	}
	const first = Math.min(anchorIndex, targetIndex);
	const last = Math.max(anchorIndex, targetIndex);
	for (const id of order.slice(first, last + 1)) next.add(id);
	return next;
}

/** Keeps the selected chats that are still present and drops the rest. */
export function pruneSelected(
	selected: ReadonlySet<string>,
	presentIds: ReadonlySet<string>,
): Set<string> {
	const next = new Set<string>();
	for (const id of selected) {
		if (presentIds.has(id)) next.add(id);
	}
	return next;
}

/**
 * What the bar's pin button does: "unpin" only when something is selected and
 * every selected chat is pinned; any other selection gets "pin", which pins the
 * unpinned ones and leaves the pinned ones where they are.
 */
export function bulkPinAction(
	selected: readonly { sidebarPinned?: boolean }[],
): "pin" | "unpin" {
	return selected.length > 0 && selected.every((chat) => chat.sidebarPinned)
		? "unpin"
		: "pin";
}

/**
 * The chats a drag carries: the whole selection, in the order shown, when the
 * row it starts on is selected; that row alone when it is not (or nothing is),
 * as a drag always did.
 */
export function draggedChatIds(
	selected: ReadonlySet<string>,
	order: readonly string[],
	id: string,
): string[] {
	if (!selected.has(id)) return [id];
	return order.filter((shownId) => selected.has(shownId));
}

/**
 * The chats a move into `projectId` changes (`null`: out of every project):
 * the ones not there already, in the order given. What the bar's Move and a
 * drop on a folder or on Chats send.
 */
export function chatsToMove(
	chats: readonly { id: string; projectId?: string | null }[],
	projectId: string | null,
): string[] {
	return chats
		.filter((chat) => (chat.projectId ?? null) !== projectId)
		.map((chat) => chat.id);
}

/** The chats a pin changes: the ones not pinned yet, in the order given. */
export function chatsToPin(
	chats: readonly { id: string; sidebarPinned?: boolean }[],
): string[] {
	return chats.filter((chat) => !chat.sidebarPinned).map((chat) => chat.id);
}
