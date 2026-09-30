<script lang="ts">
// A test host for the blocks made from the chat: a node drawn the way the board
// draws it (`WithBoard`), under the chat context the editor provides (the
// conversation the panel shows, the way to open a file in the panel, the
// listing behind "From this chat").
import type { Component } from "svelte";
import {
	type CanvasChatContext,
	provideChatContext,
} from "../_lib/chat-context";
import type { CanvasBoardContext } from "../_lib/board-context";
import WithBoard from "./WithBoard.svelte";

let {
	component,
	componentProps,
	context,
	chat,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: a test host renders any node component, whatever its props
	component: Component<any>;
	componentProps: Record<string, unknown>;
	context: CanvasBoardContext;
	chat: CanvasChatContext;
} = $props();

// The context is fixed for the life of a test host.
// svelte-ignore state_referenced_locally
provideChatContext(chat);
</script>

<WithBoard {component} {componentProps} {context} />
