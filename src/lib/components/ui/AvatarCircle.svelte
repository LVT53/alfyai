<script lang="ts">
import { getAvatarColor } from "$lib/utils/avatar";

let {
	userId,
	name = null,
	avatarId = null,
	size = 28,
	profilePicture = null,
	cacheBuster = 0,
}: {
	userId: string;
	name?: string | null;
	avatarId?: number | null;
	size?: number;
	profilePicture?: string | null;
	cacheBuster?: number;
} = $props();

const color = $derived(getAvatarColor(avatarId, userId));
const initial = $derived(
	name ? name[0].toUpperCase() : (userId[0] ?? "?").toUpperCase(),
);
const fontSize = $derived(Math.round(size * 0.42));
let imgFailed = $state(false);
const imgSrc = $derived(
	profilePicture
		? `/api/avatar/${userId}${cacheBuster ? `?t=${cacheBuster}` : ""}`
		: null,
);

// Reset failure state when the source URL changes (e.g. after upload).
$effect(() => {
	if (imgSrc) imgFailed = false;
});
</script>

{#if imgSrc && !imgFailed}
	<img
		src={imgSrc}
		alt={name ?? userId}
		class="avatar-circle flex-shrink-0 select-none rounded-full object-cover"
		style="width: {size}px; height: {size}px;"
		aria-hidden="true"
		onerror={() => { imgFailed = true; }}
	/>
{:else}
	<div
		class="avatar-circle flex-shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
		style="width: {size}px; height: {size}px; background: {color}; font-size: {fontSize}px; line-height: {size}px; text-align: center;"
		aria-hidden="true"
	>
		{initial}
	</div>
{/if}

<style>
	.avatar-circle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
</style>
