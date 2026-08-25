import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CreativeOutputSchema } from "@fulcrum/domain";
import { assertStrictCompatibleJsonSchema } from "@fulcrum/execution";

import {
  LiveDirectionSetOutputSchema,
  LiveDirectionTemplateSchema,
  LiveFocusedDirectionOutputSchema,
  LiveGameDesignSpecOutputSchema,
  LiveInterrogationFirstRoundSchema,
  LiveInterrogationNextRoundSchema,
} from "./m1-live-text.js";

const liveOutputSchemas = {
  CreativeOutputSchema,
  LiveInterrogationFirstRoundSchema,
  LiveInterrogationNextRoundSchema,
  LiveGameDesignSpecOutputSchema,
  LiveDirectionSetOutputSchema,
  LiveDirectionTemplateSchema,
  LiveFocusedDirectionOutputSchema,
} as const;

describe("M1 live text JSON Schema", () => {
  it.each(Object.entries(liveOutputSchemas))(
    "%s is OpenAI strict-compatible",
    (_name, schema) => {
      expect(() =>
        assertStrictCompatibleJsonSchema(z.toJSONSchema(schema)),
      ).not.toThrow();
    },
  );

  it("emits a fixed-length directions array without tuple prefixItems", () => {
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
