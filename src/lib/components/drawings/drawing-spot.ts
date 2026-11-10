/**
 * The spots of a drawing: the parts of it a row of the guide can light.
 *
 * A control a row points at carries `data-drawing-spot="<id>"` and, while that
 * row is hovered, focused or tapped, the class `drawing-spot-lit`. The ring
 * itself is `src/app.css`'s, the same one Show me puts on the real control.
 * The drawing names the ids; a part marks the ids it is given.
 *
 * `spot` is `undefined` for a control the drawing does not point at, and such
 * a control is never lit, whatever is.
 */
export function isLit(
	spot: string | null | undefined,
	lit: string | null | undefined,
): boolean {
	return spot != null && lit != null && spot === lit;
}
