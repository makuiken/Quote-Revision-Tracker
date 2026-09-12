export * from "./generated/api";
export * from "./generated/types";
// Both generated modules export a `DeleteDependentFieldOptionsParams` (the zod
// path-params schema in api.ts, and the query-params TS type in types/).
// Explicitly re-export the zod schema — the server validates with it; the
// query-params type is only used by the react client's own generated copy.
export { DeleteDependentFieldOptionsParams } from "./generated/api";
// OpenAPI has both path params and query params for this operation. The server
// must receive the Zod path validator rather than the generated query type.
export { GetPublicManufacturerPacketPageParams } from "./generated/api";
export { GetPublicManufacturerPacketPageQueryParams } from "./generated/api";
export { GetManufacturerPacketManifestParams } from "./generated/api";
export { GetManufacturerPacketPageParams } from "./generated/api";
export { GetPublicScopedManufacturerPacketPageParams } from "./generated/api";
