import { Ajv } from "ajv";

/** A value `JSON.parse` can produce. Request bodies and jsonb columns are typed with it until a validator narrows them. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

export interface JsonObject {
  [key: string]: Json | undefined;
}

// Schema validators double as type guards, so a value is checked by the same code that narrows its type.
const schemas = new Ajv({ strict: true });

export const isString = schemas.compile<string>({ type: "string" });

export const isNumber = schemas.compile<number>({ type: "number" });

/** True for a plain JSON object: not null, not an array. */
export const isJsonObject = schemas.compile<JsonObject>({ type: "object" });

/** An object with the given fields still unchecked; the caller validates each one. */
export function fieldsOf(body: Json | undefined): JsonObject {
  return isJsonObject(body) ? body : {};
}
