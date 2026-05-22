<script lang="ts">
import type { ConversationListItem } from "$lib/types";
import ConversationItem from "./ConversationItem.svelte";

type SelectPayload = { id: string };
type RenamePayload = { id: string; title: string };
type DeletePayload = { id: string };
type TogglePinPayload = { id: string; pinned: boolean };

let {
	conversation,
	active = false,
	onSelect = () => {},
	onRename = () => {},
	onDelete = () => {},
	onTogglePin = () => {},
}: {
	conversation: ConversationListItem;
	active?: boolean;
	onSelect?: (event: SelectPayload) => void;
	onRename?: (event: RenamePayload) => void;
	onDelete?: (event: DeletePayload) => void;
	onTogglePin?: (event: TogglePinPayload) => void;
} = $props();

let menuOpen = $state(false);
</script>

<ConversationItem 
	{conversation} 
	{active}
	{menuOpen}
	onSelect={onSelect}
	onRename={onRename}
	onDelete={onDelete}
	onTogglePin={onTogglePin}
	onMenuToggle={(payload) => (menuOpen = payload.open)}
	onMenuClose={() => (menuOpen = false)}
/>
