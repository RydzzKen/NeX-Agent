import { z } from "zod";

/**
 * Konverter minimal JSON Schema → Zod untuk skema tool eksternal (MCP).
 *
 * Loop agent memvalidasi argumen tool dengan Zod, sedangkan server MCP
 * menyatakan input-nya sebagai JSON Schema. Konverter ini mendukung subset yang
 * umum dipakai: `object` (properties/required/additionalProperties), `array`,
 * `string`, `number`, `integer`, `boolean`, `null`, `enum`, `const`, serta
 * `anyOf`/`oneOf`.
 *
 * Tipe yang tidak dikenali menjadi `unknown` (permisif): keamanan tidak
 * bergantung pada validasi skema, melainkan pada klasifikasi risiko tool dan
 * persetujuan pengguna. Skema yang tetap ditolak server akan dikembalikan ke
 * model sebagai hasil tool, bukan membuat sesi gagal.
 */

type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literalUnion(values: readonly unknown[]): z.ZodTypeAny | undefined {
  const usable = values.filter(
    (v): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  if (usable.length === 0) return undefined;
  return unionOf(usable.map((v) => z.literal(v)));
}

/** Gabung beberapa skema menjadi union (`z.union` butuh minimal dua). */
function unionOf(options: z.ZodTypeAny[]): z.ZodTypeAny {
  if (options.length === 0) return z.unknown();
  if (options.length === 1) return options[0]!;
  return z.union([options[0]!, options[1]!, ...options.slice(2)]);
}

function withDescription(schema: z.ZodTypeAny, description: unknown): z.ZodTypeAny {
  return typeof description === "string" && description ? schema.describe(description) : schema;
}

function buildObject(schema: JsonSchema): z.ZodTypeAny {
  const rawProperties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [],
  );
  const additional = schema.additionalProperties;
  const extra = isPlainObject(additional) ? jsonSchemaToZod(additional) : undefined;

  const keys = Object.keys(rawProperties);
  if (keys.length === 0) {
    // Tanpa properti terdaftar: objek bebas, kecuali dilarang eksplisit.
    if (additional === false) return z.object({}).strict();
    return z.record(extra ?? z.unknown());
  }

  const shape: z.ZodRawShape = {};
  for (const key of keys) {
    const property = jsonSchemaToZod(rawProperties[key]);
    shape[key] = required.has(key) ? property : property.optional();
  }

  if (additional === false) return z.object(shape).strict();
  if (extra) return z.object(shape).catchall(extra);
  // JSON Schema: `additionalProperties` tak dinyatakan = diizinkan, jadi
  // argumen tak terdaftar tetap diteruskan ke server (yang memvalidasinya).
  return z.object(shape).passthrough();
}

function buildType(schema: JsonSchema, type: string): z.ZodTypeAny {
  switch (type) {
    case "object":
      return buildObject(schema);
    case "array": {
      const items = schema.items;
      // Bentuk tuple (array dari skema) sengaja dilonggarkan menjadi array bebas.
      const inner = isPlainObject(items) ? jsonSchemaToZod(items) : z.unknown();
      return z.array(inner);
    }
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      return z.unknown();
  }
}

function build(schema: JsonSchema): z.ZodTypeAny {
  const description = schema.description;

  const variants = [schema.anyOf, schema.oneOf].find(
    (candidate): candidate is unknown[] => Array.isArray(candidate) && candidate.length > 0,
  );
  if (variants) {
    const union = withDescription(unionOf(variants.map((variant) => jsonSchemaToZod(variant))), description);
    return union;
  }

  if (Array.isArray(schema.enum)) {
    const literals = literalUnion(schema.enum);
    if (literals) return withDescription(literals, description);
  }

  if ("const" in schema) {
    const literals = literalUnion([schema.const]);
    if (literals) return withDescription(literals, description);
  }

  const declared = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];

  let base: z.ZodTypeAny;
  if (declared.length === 0) {
    // `type` boleh hilang; bila ada `properties` tetap perlakukan sebagai objek.
    base = isPlainObject(schema.properties) ? buildObject(schema) : z.unknown();
  } else if (declared.length === 1) {
    base = buildType(schema, declared[0]!);
  } else {
    base = unionOf(declared.map((t) => buildType(schema, t)));
  }
  return withDescription(base, description);
}

/**
 * Ubah JSON Schema (skema input tool MCP) menjadi skema Zod.
 *
 * `true` → skema apa pun valid; `false` → tidak ada input yang valid; selain itu
 * objek skema diurai sesuai subset di atas.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (schema === true || schema === undefined) return z.unknown();
  if (schema === false) return z.never();
  if (!isPlainObject(schema)) return z.unknown();
  return build(schema);
}
