// Internal: no external consumers after the colour-switcher removal. Avatar
// colour is always derived from a deterministic hash of the userId.
const AVATAR_COLORS = [
	"#C15F3C", // accent coral
	"#5B7FA6", // slate blue
	"#6B9E78", // sage green
	"#9B6B9E", // dusty purple
	"#C4956A", // warm tan
	"#7B9E9B", // teal
	"#B87D7D", // dusty rose
	"#8A8A6B", // olive
];

export function getAvatarColor(userId: string): string {
	// Deterministic hash of userId into the palette.
	const hash = userId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
	return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
