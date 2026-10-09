import { z } from "zod";

/**
 * Konverter minimal Zod → JSON Schema untuk subset yang dipakai tool.
 * Menghindari dependensi tambahan; hanya mendukung tipe yang kita pakai.
 */

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
}

function defOf(schema: z.ZodTypeAny): Record<string, unknown> {
  return (schema as unknown as { _def: Record<string, unknown> })._def;
}

function describe(schema: z.ZodTypeAny): string | undefined {
  return schema.description || undefined;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const type = defOf(schema).typeName as string;
  const description = describe(schema);

  switch (type) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
          required.push(key);
        }
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      if (description) out.description = description;
      return out;
    }
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      if (description) out.description = description;
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      if (description) out.description = description;
      return out;
    }
    case "ZodBoolean": {
      const out: JsonSchema = { type: "boolean" };
      if (description) out.description = description;
      return out;
    }
    case "ZodArray": {
      const inner = (schema as z.ZodArray<z.ZodTypeAny>).element;
      const out: JsonSchema = { type: "array", items: zodToJsonSchema(inner) };
      if (description) out.description = description;
      return out;
    }
    case "ZodEnum": {
      const values = Object.values((defOf(schema).values as Record<string, string>) ?? {});
      const out: JsonSchema = { type: "string", enum: values };
      if (description) out.description = description;
      return out;
    }
    case "ZodNativeEnum": {
      const values = Object.values((defOf(schema).values as Record<string, string>) ?? {});
      const out: JsonSchema = { type: "string", enum: values };
      if (description) out.description = description;
      return out;
    }
    case "ZodOptional":
    case "ZodNullable": {
      const inner = (schema as z.ZodOptional<z.ZodTypeAny>).unwrap();
      return zodToJsonSchema(inner);
    }
    case "ZodDefault": {
      const d = schema as z.ZodDefault<z.ZodTypeAny>;
      const inner = zodToJsonSchema(d.removeDefault());
      return { ...inner, default: d._def.defaultValue() };
    }
    case "ZodRecord": {
      const out: JsonSchema = {
        type: "object",
        additionalProperties: zodToJsonSchema((schema as z.ZodRecord<z.ZodTypeAny>).valueSchema),
      };
      if (description) out.description = description;
      return out;
    }
    default: {
      const out: JsonSchema = {};
      if (description) out.description = description;
      return out;
    }
  }
}
