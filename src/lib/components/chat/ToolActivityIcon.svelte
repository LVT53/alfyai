<script lang="ts">
// The 14px tool-identity glyph of a unified activity row. Extracted from
// ThinkingBlock's old `toolIdentityIcon` snippet so the row, the collapsed
// summary strip and any future caller all render the SAME glyph per tool —
// an if/else over a string tag, matching this codebase's established idiom
// for "pick one of a few known icons" (no dynamic-component map).
//
// The nine connection-tool cases reuse the exact same Lucide glyph
// SettingsConnectionsTab's CAPABILITY_ICONS uses per capability, so a
// "Calendar" tool call reads as the same calendar glyph everywhere.
import {
	Brain,
	Calendar,
	Clapperboard,
	FileText,
	Folder,
	GitBranch,
	Globe,
	Image as ImageIcon,
	Images,
	Link,
	ListTodo,
	Mail,
	MapPin,
	Sparkles,
	Terminal,
	Users,
	Wrench,
} from "@lucide/svelte";
import type { ToolCallIconType } from "$lib/utils/tool-calls";

let { iconType, size = 14 }: { iconType: ToolCallIconType; size?: number } =
	$props();
</script>

{#if iconType === 'web-search'}
	<Globe class="tool-activity-icon" data-tool-icon="web-search" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'fetch-url'}
	<Link class="tool-activity-icon" data-tool-icon="fetch-url" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'image-search'}
	<Images class="tool-activity-icon" data-tool-icon="image-search" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'memory'}
	<Brain class="tool-activity-icon" data-tool-icon="memory" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'file-production'}
	<FileText class="tool-activity-icon" data-tool-icon="file-production" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'run-python'}
	<Terminal class="tool-activity-icon" data-tool-icon="run-python" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'map-route'}
	<MapPin class="tool-activity-icon" data-tool-icon="map-route" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'use-skill'}
	<Sparkles class="tool-activity-icon" data-tool-icon="use-skill" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'calendar'}
	<Calendar class="tool-activity-icon" data-tool-icon="calendar" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'contacts'}
	<Users class="tool-activity-icon" data-tool-icon="contacts" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'email'}
	<Mail class="tool-activity-icon" data-tool-icon="email" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'files'}
	<Folder class="tool-activity-icon" data-tool-icon="files" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'location'}
	<MapPin class="tool-activity-icon" data-tool-icon="location" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'media'}
	<Clapperboard class="tool-activity-icon" data-tool-icon="media" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'photos'}
	<ImageIcon class="tool-activity-icon" data-tool-icon="photos" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'repos'}
	<GitBranch class="tool-activity-icon" data-tool-icon="repos" {size} strokeWidth={2} aria-hidden="true" />
{:else if iconType === 'tasks'}
	<ListTodo class="tool-activity-icon" data-tool-icon="tasks" {size} strokeWidth={2} aria-hidden="true" />
{:else}
	<Wrench class="tool-activity-icon" data-tool-icon="generic" {size} strokeWidth={2} aria-hidden="true" />
{/if}

<style>
	:global(.tool-activity-icon) {
		color: currentColor;
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		opacity: 0.85;
	}
</style>
