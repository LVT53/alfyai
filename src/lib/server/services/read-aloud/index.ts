// The read-aloud service's public surface for routes. Routes import from here,
// never from the files behind it.

export { wordsFitReply } from "./containment";
export {
	attachAudio,
	attachEvents,
	closeReading,
	currentReading,
	openReading,
	type Reading,
	reportPosition,
} from "./readings";
export {
	charsPerSecondByLanguage,
	positionRequestSchema,
	type ReadingRequest,
	readingRequestSchema,
	speechSentencesFor,
} from "./request";
export { SpeechRefused, SpeechUnavailable } from "./speech-client";
