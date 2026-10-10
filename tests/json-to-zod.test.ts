import { z } from "zod";
import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "../src/tools/json_to_zod.js";

describe("jsonSchemaToZod", () => {
  it("mengubah object dengan required dan optional", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(schema.safeParse({ a: "x" }).success).toBe(true);
    expect(schema.safeParse({ a: "x", b: 2 }).success).toBe(true);
    expect(schema.safeParse({ b: 2 }).success).toBe(false);
  });

  it("strict bila additionalProperties:false; meneruskan bila tak dinyatakan", () => {
    const strict = jsonSchemaToZod({ type: "object", properties: {}, additionalProperties: false });
    expect(strict.safeParse({}).success).toBe(true);
    expect(strict.safeParse({ x: 1 }).success).toBe(false);

    const open = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } } });
    expect(open.safeParse({ a: "s", ekstra: true }).success).toBe(true);

    const typed = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: { type: "number" },
    });
    expect(typed.safeParse({ a: "s", bonus: 1 }).success).toBe(true);
    expect(typed.safeParse({ a: "s", bonus: "x" }).success).toBe(false);
  });

  it("enum dan anyOf menjadi union literal", () => {
    const enumerated = jsonSchemaToZod({ type: "string", enum: ["a", "b"] });
    expect(enumerated.safeParse("a").success).toBe(true);
    expect(enumerated.safeParse("c").success).toBe(false);

    const anyOf = jsonSchemaToZod({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(anyOf.safeParse("x").success).toBe(true);
    expect(anyOf.safeParse(1).success).toBe(true);
    expect(anyOf.safeParse(true).success).toBe(false);
  });

  it("menangani array, nested object, integer, dan tipe ganda", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "integer" } },
        nested: { type: "object", properties: { deep: { type: "boolean" } }, required: ["deep"] },
        maybe: { type: ["string", "null"] },
      },
      required: ["items"],
    });
    expect(schema.safeParse({ items: [1, 2] }).success).toBe(true);
    expect(schema.safeParse({ items: [1.5] }).success).toBe(false);
    expect(schema.safeParse({ items: [], nested: { deep: true } }).success).toBe(true);
    expect(schema.safeParse({ items: [], nested: {} }).success).toBe(false);
    expect(schema.safeParse({ items: [], maybe: null }).success).toBe(true);
  });

  it("skema tak dikenal bersifat permisif; `false` = tak ada input valid", () => {
    expect(jsonSchemaToZod(undefined).safeParse({}).success).toBe(true);
    expect(jsonSchemaToZod({}).safeParse("apa saja").success).toBe(true);
    expect(jsonSchemaToZod({ type: "tipe-aneh" }).safeParse(123).success).toBe(true);
    expect(jsonSchemaToZod(false).safeParse({}).success).toBe(false);
  });

  it("mempertahankan deskripsi pada properti", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string", description: "Teks singkat" } },
    }) as z.ZodObject<z.ZodRawShape>;
    expect(schema.shape.a?.description).toBe("Teks singkat");
  });

  it("const menjadi literal", () => {
    const schema = jsonSchemaToZod({ type: "string", const: "lokal" });
    expect(schema.safeParse("lokal").success).toBe(true);
    expect(schema.safeParse("lain").success).toBe(false);
  });
});