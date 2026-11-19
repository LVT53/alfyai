// What one reading session may hold. The speech service takes 1 to 2000 sentences in a session
// (`deploy/speech-service/README.md`), so the session route's schema refuses more, and the browser
// sends a longer reply in sessions of this size, the next one opening where one ended (early
// review R21). Both sides read it here, so they cannot disagree.

export const MAX_SENTENCES_PER_SESSION = 2000;

/** The longest a word may be written in a request (`shown`): the session route refuses a longer one, whatever it is read as. */
export const MAX_SHOWN_CHARS = 2048;
