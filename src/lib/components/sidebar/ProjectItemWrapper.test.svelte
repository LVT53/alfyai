<script lang="ts">
import type { Project } from "$lib/server/services/projects";
import ProjectItem from "./ProjectItem.svelte";

type TogglePayload = { id: string; expanded: boolean };
type OpenProjectPayload = { id: string; focusComposer?: boolean };
type ProjectIdPayload = { id: string };
type RenamePayload = { id: string; name: string };

let {
	project,
	expanded = true,
	onToggle = () => {},
	onOpenProject = () => {},
	onRename = () => {},
	onDelete = () => {},
}: {
	project: Project;
	expanded?: boolean;
	onToggle?: (event: TogglePayload) => void;
	onOpenProject?: (event: OpenProjectPayload) => void;
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
	onOpenProject={onOpenProject}
	onRename={onRename}
	onDelete={onDelete}
	onMenuToggle={(payload) => (menuOpen = payload.open)}
	onMenuClose={() => (menuOpen = false)}
/>
