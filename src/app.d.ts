declare global {
	namespace App {
		interface Locals {
			user: import("$lib/types").SessionUser | null;
		}
	}
}
export {};
