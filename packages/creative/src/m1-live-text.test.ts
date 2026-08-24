import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LiveDirectionSetOutputSchema,
  LiveDirectionTemplateSchema,
  LiveFocusedDirectionOutputSchema,
  LiveGameDesignSpecOutputSchema,
  LiveInterrogationFirstRoundSchema,
  LiveInterrogationNextRoundSchema,
} from "./m1-live-text.js";

const liveOutputSchemas = {
  LiveInterrogationFirstRoundSchema,
  LiveInterrogationNextRoundSchema,
  LiveGameDesignSpecOutputSchema,
  LiveDirectionSetOutputSchema,
  LiveDirectionTemplateSchema,
  LiveFocusedDirectionOutputSchema,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

const assertStrictObjectNodes = (node: unknown, path: string): void => {
  if (!isRecord(node)) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      assertStrictObjectNodes(item, `${path}[${index}]`),
    );
    return;
  }
  const isObjectSchema =
    node.type === "object" ||
    (isRecord(node.properties) && !Array.isArray(node.properties));
  if (isObjectSchema) {
    const properties = isRecord(node.properties)
      ? Object.keys(node.properties)
      : [];
    expect(node.required, `${path}.required`).toBeInstanceOf(Array);
    const required = node.required as string[];
    for (const key of properties) {
      expect(required, `${path}.required`).toContain(key);
    }
    expect(node.additionalProperties, `${path}.additionalProperties`).toBe(
      false,
    );
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      assertStrictObjectNodes(value, `${path}.${key}`);
    }
  }
};

describe("M1 live text JSON Schema", () => {
  it("strict-schema-compat", () => {
    for (const [name, schema] of Object.entries(liveOutputSchemas)) {
      let json: Record<string, unknown> | undefined;
      expect(() => {
        json = z.toJSONSchema(schema) as Record<string, unknown>;
      }, name).not.toThrow();
      expect(json, name).toBeDefined();
      assertStrictObjectNodes(json, name);
    }

    const directions = z.toJSONSchema(LiveDirectionSetOutputSchema) as {
      properties?: { directions?: Record<string, unknown> };
    };
    const directionsSchema = directions.properties?.directions;
    expect(directionsSchema?.prefixItems).toBeUndefined();
    expect(directionsSchema?.minItems).toBe(3);
    expect(directionsSchema?.maxItems).toBe(3);
    expect(directionsSchema?.items).toMatchObject({ type: "object" });
  });
});
