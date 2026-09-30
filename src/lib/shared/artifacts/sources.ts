import type { GroundedWebPayloadSource } from "$lib/server/services/web-grounding";

/**
 * A web source as the family shows it: the existing web-grounding payload
 * source (`web-grounding.ts`), aliased, never a second shape. Type-only, so a
 * browser bundle never carries the server module; `canvas-blocks.ts` mirrors it
 * in a zod schema and pins the two together at compile time.
 */
export type ArtifactSource = GroundedWebPayloadSource;
