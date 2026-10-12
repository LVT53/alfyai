declare global {
	namespace App {
		interface Locals {
			user: import("$lib/server/services/auth-types").SessionUser | null;
		}
		/** What a history entry remembers (SvelteKit's shallow routing): which layer of the chat's panel it shows. */
		interface PageState {
			alfyPanel?: import("$lib/client/panel-history").PanelEntry;
		}
	}
}

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";

	export function gfm(service: TurndownService): void;
	export function tables(service: TurndownService): void;
	export function strikethrough(service: TurndownService): void;
	export function taskListItems(service: TurndownService): void;
}

export {};
