<script lang="ts">
import type { Project } from "$lib/server/services/projects";
import ProjectItem from "./ProjectItem.svelte";

type TogglePayload = { id: string; expanded: boolean };
type ProjectIdPayload = { id: string };
type RenamePayload = { id: string; name: string };

let {
	project,
	expanded = true,
	onToggle = () => {},
	onCreateConversation = () => {},
	onRename = () => {},
	onDelete = () => {},
}: {
	project: Project;
	expanded?: boolean;
	onToggle?: (event: TogglePayload) => void;
	onCreateConversation?: (event: ProjectIdPayload) => void;
	onRename?: (event: RenamePayload) => void;
	onDelete?: (event: ProjectIdPayload) => void;
} = $props();

let menuOpen = $state(false);
</script>

<ProjectItem
	{project}
	{expanded}
	{menuOpen}
	onToggle={onToggle}
	onCreateConversation={onCreateConversation}
	onRename={onRename}
	onDelete={onDelete}
	onMenuToggle={(payload) => (menuOpen = payload.open)}
	onMenuClose={() => (menuOpen = false)}
/>
