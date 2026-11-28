<script lang="ts">
// Connections redesign — one chip under a connection's name.
//
// Three states, three readings: `on` is a capability Alfy may use right now,
// `off` is one the user switched off, and `denied` is one the provider
// refused. The last two used to look identical (both simply absent from the
// row), which meant a Google account missing Contacts because the consent
// screen said no was indistinguishable from one the user turned off — the
// first needs a trip back to Google, the second needs one switch.
import {
	Bike,
	Calendar,
	MessageSquare,
	MessagesSquare,
	Clapperboard,
	Music,
	Tv,
	Folder,
	GitBranch,
	Image as ImageIcon,
	ListTodo,
	Mail,
	MapPin,
	Pencil,
	Users,
} from "@lucide/svelte";
import type { CapabilityChip } from "$lib/client/connections/status-grammar";
import type { Capability } from "$lib/client/connections/provider-catalog";
import type { PlexCategory } from "$lib/shared/plex-categories";
import { t } from "$lib/i18n";

const CAPABILITY_ICONS: Record<Capability | PlexCategory, typeof Calendar> = {
	cycling: Bike,
	calendar: Calendar,
	files: Folder,
	photos: ImageIcon,
	email: Mail,
	media: Clapperboard,
	movies: Clapperboard,
	tv: Tv,
	music: Music,
	location: MapPin,
	contacts: Users,
	repos: GitBranch,
	tasks: ListTodo,
	teams_chat: MessageSquare,
	teams_channels: MessagesSquare,
	teams_files: Folder,
};

let { chip }: { chip: CapabilityChip } = $props();

const capabilityLabel = $derived.by(() => {
	if (chip.kind !== "capability") return "";
	return $t(
		`connections.capability.${chip.capability}` as Parameters<typeof $t>[0],
	);
});

const writeLabel = $derived.by(() => {
	if (chip.kind !== "writes") return "";
	if (chip.variant === "folders") {
		return chip.folderCount === 0
			? $t("connections.chip.writesDefaultFolder")
			: $t("connections.chip.writesFolders", { count: chip.folderCount });
	}
	if (chip.variant === "drafts") return $t("connections.chip.writesDrafts");
	return $t("connections.chip.writesConfirm");
});
</script>

{#if chip.kind === 'capability'}
	{@const Icon = CAPABILITY_ICONS[chip.capability]}
	<span class="cap-chip" class:off={chip.state !== 'on'} data-chip-state={chip.state}>
		{#if Icon}
			<Icon size={11} strokeWidth={2} aria-hidden="true" />
		{/if}
		{chip.state === 'denied'
			? $t('connections.chip.denied', { capability: capabilityLabel })
			: capabilityLabel}
	</span>
{:else}
	<span class="cap-chip" data-chip-state="write">
		<Pencil size={11} strokeWidth={2} aria-hidden="true" />
		{writeLabel}
	</span>
{/if}

<style>
	.cap-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.6875rem;
		line-height: 1.3;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.cap-chip.off {
		background: transparent;
		border-color: transparent;
		color: var(--text-muted);
		opacity: 0.72;
	}
</style>
