import { json } from "@sveltejs/kit";
import {
	getStreamStats,
	isDraining,
} from "$lib/server/services/chat-turn/active-streams";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
	return json({
		status: "OK",
		draining: isDraining(),
		activeStreams: getStreamStats().globalActiveCount,
	});
};
