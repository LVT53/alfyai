import type { ThinkingSegment } from "$lib/server/services/messages-types";
import type { RenderMarkdownOptions } from "$lib/services/markdown";
import {
	type ToolImage,
	toolImages,
	toolSourceHosts,
} from "$lib/shared/url-provenance";

/**
 * What a reply may show of the web without a click: the pictures its own
 * image_search calls returned and the hosts its tool calls returned
 * (docs/plans/exfil-channels). The renderer takes these as its options.
 */
export type MessageRenderResources = Pick<
	RenderMarkdownOptions,
	"toolImages" | "toolSourceHosts"
>;

/**
 * The content of a message's tool results as one string, empty when no tool
 * returned a picture or an address. The message object is replaced on every
 * streamed token and refreshed from the server, and its segments with it; only a
 * tool that really returned something new should make the renderer draw every
 * block again. So the chat compares this string, which holds the same content
 * for the same results, and builds the resources from it
 * (`messageRenderResourcesFromKey`) only when it changes.
 */
export function messageRenderResourcesKey(
	segments: readonly ThinkingSegment[] | null | undefined,
): string {
	const images = toolImages(segments);
	const hosts = [...toolSourceHosts(segments)].sort();
	if (images.length === 0 && hosts.length === 0) return "";
	return JSON.stringify([images, hosts]);
}

/** The resources a key stands for (undefined for the empty key: nothing may be shown). */
export function messageRenderResourcesFromKey(
	key: string,
): MessageRenderResources | undefined {
	if (!key) return undefined;
	const [images, hosts] = JSON.parse(key) as [ToolImage[], string[]];
	return { toolImages: images, toolSourceHosts: new Set(hosts) };
}
