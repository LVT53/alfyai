/**
 * What a block is taken to occupy when nothing has measured it, for whoever PLANS
 * a board without a browser: the model's read, the placer (`board-placement.ts`),
 * the judge, the eval. It is `estimatedNodeSize` with the one thing that module
 * leaves to its caller, a diagram's height, read from the diagram's source
 * (`mermaid-size.ts`). The editor measures its blocks, and keeps this out of its
 * first paint: use `estimatedNodeSize` there (ruling 68, ruling 74).
 */
import type { CanvasNode } from "./canvas";
import { estimatedNodeSize } from "./canvas-blocks";
import { estimatedDiagramHeight } from "./mermaid-size";

export function plannedNodeSize(
	node: Pick<CanvasNode, "type" | "width" | "height" | "data">,
): { width: number; height: number } {
	return estimatedNodeSize(node, estimatedDiagramHeight);
}
