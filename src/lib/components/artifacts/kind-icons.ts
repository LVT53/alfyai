/**
 * The one Lucide icon per artifact kind (ADR-0066), shared by
 * `ArtifactCard.svelte` and `ArtifactPanelHeader.svelte` so a kind's icon
 * never drifts between the list/card and the open item's own header.
 */
import {
	AppWindow,
	FileText,
	Presentation,
	Shapes,
	SquarePen,
} from "@lucide/svelte";
import type { Component } from "svelte";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export const ARTIFACT_KIND_ICONS: Record<ArtifactKind, Component> = {
	file: FileText,
	document: SquarePen,
	app: AppWindow,
	canvas: Shapes,
	slides: Presentation,
};
