export const AVATAR_COLORS = [
	"#C15F3C", // accent coral
	"#5B7FA6", // slate blue
	"#6B9E78", // sage green
	"#9B6B9E", // dusty purple
	"#C4956A", // warm tan
	"#7B9E9B", // teal
	"#B87D7D", // dusty rose
	"#8A8A6B", // olive
];

export const AVATAR_COUNT = AVATAR_COLORS.length;

export function getAvatarColor(
	avatarId: number | null,
	userId: string,
): string {
	if (avatarId !== null && avatarId >= 0) {
		return AVATAR_COLORS[avatarId % AVATAR_COLORS.length];
	}
	// Fallback: deterministic hash of userId
	const hash = userId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
	return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
