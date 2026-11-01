<script lang="ts">
import type { ConversationListItem } from "$lib/server/services/conversations";
import type { Project } from "$lib/server/services/projects";
import ConversationItem from "./ConversationItem.svelte";

type SelectPayload = { id: string };
type SelectionTogglePayload = { id: string; range: boolean };
type RenamePayload = { id: string; title: string };
type DeletePayload = { id: string };
type TogglePinPayload = { id: string; pinned: boolean };
type MovePayload = { id: string; projectId: string | null };

let {
	conversation,
	active = false,
	selecting = false,
	selected = false,
	dragEnabled = false,
	dragImage = null,
	projects = [],
	onSelect = () => {},
	onSelectionToggle = () => {},
	onRename = () => {},
	onDelete = () => {},
	onTogglePin = () => {},
	onMoveToProject = () => {},
	onDragStart = () => {},
}: {
	conversation: ConversationListItem;
	active?: boolean;
	selecting?: boolean;
	selected?: boolean;
	dragEnabled?: boolean;
	dragImage?: HTMLElement | null;
	projects?: Project[];
	onSelect?: (event: SelectPayload) => void;
	onSelectionToggle?: (event: SelectionTogglePayload) => void;
	onRename?: (event: RenamePayload) => void;
	onDelete?: (event: DeletePayload) => void;
	onTogglePin?: (event: TogglePinPayload) => void;
	onMoveToProject?: (event: MovePayload) => void;
	onDragStart?: (event: { id: string }) => void;
} = $props();

let menuOpen = $state(false);
</script>

<ConversationItem
	{conversation}
	{active}
	{selecting}
	{selected}
	{dragEnabled}
	{dragImage}
	{projects}
	{menuOpen}
	onSelect={onSelect}
	onSelectionToggle={onSelectionToggle}
	onRename={onRename}
	onDelete={onDelete}
	onTogglePin={onTogglePin}
	onMoveToProject={onMoveToProject}
	onDragStart={onDragStart}
	onMenuToggle={(payload) => (menuOpen = payload.open)}
	onMenuClose={() => (menuOpen = false)}
/>
