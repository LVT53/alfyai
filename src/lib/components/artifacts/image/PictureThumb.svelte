<script lang="ts">
// A picture's thumbnail in a list (plan 2b Task 22: "in the list of images
// there should be [a] preview present"): the 320 px file, square-cropped, in a
// 40 px box reserved before it loads, so it fades in (`ImagePicture`) and
// nothing moves. `fill` makes it fill a box its parent reserves (a gallery
// tile). The one thumbnail of the chat's items list and the Knowledge Base.
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
import ImagePicture from "./ImagePicture.svelte";

let {
	fileId,
	hasAlpha = false,
	conversationId = null,
	fill = false,
	testId = "picture-thumb",
}: {
	fileId: string;
	hasAlpha?: boolean;
	conversationId?: string | null;
	fill?: boolean;
	testId?: string;
} = $props();
</script>

<span class="picture-thumb" class:is-fill={fill} aria-hidden="true" data-testid={testId}>
	<ImagePicture
		{fileId}
		width={IMAGE_THUMB_LONG_EDGE}
		height={IMAGE_THUMB_LONG_EDGE}
		{hasAlpha}
		alt=""
		{conversationId}
		variant="thumb"
	/>
</span>

<style>
	.picture-thumb {
		display: block;
		width: 40px;
		height: 40px;
		flex: 0 0 auto;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px var(--border-default);
	}

	.picture-thumb.is-fill {
		width: 100%;
		height: 100%;
		border-radius: 0;
		box-shadow: none;
	}

	.picture-thumb :global(.image-picture) {
		height: 100%;
	}

	.picture-thumb :global(.image-picture-img) {
		object-fit: cover;
	}
</style>
