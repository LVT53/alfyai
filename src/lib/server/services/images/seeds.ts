export const SEED_MAX = 2 ** 48 - 1;

/** A fresh whole-number seed in [1, SEED_MAX], never one of `avoid`. */
export function freshSeed(
	avoid: readonly number[],
	random: () => number = Math.random,
): number {
	for (;;) {
		const seed = 1 + Math.floor(random() * SEED_MAX);
		if (seed <= SEED_MAX && !avoid.includes(seed)) return seed;
	}
}
