// The server's one way out to addresses it did not choose. Callers import from
// here only; see fetch.ts for what the connection guarantees and
// public-address.ts for what counts as public.
export {
	assessOutboundUrl,
	createOutboundFetch,
	type HostResolver,
	type OutboundFailureCode,
	type OutboundFetch,
	OutboundFetchError,
} from "./fetch";
export { isReservedHostname } from "./public-address";
