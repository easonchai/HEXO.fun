import { describe, expect, it } from "vitest";

import { idl } from "./idl.js";
import { EVENT_NAMES } from "./useProgramEvents.js";

describe("useProgramEvents subscription list", () => {
  it("subscribes only to event names the IDL declares", () => {
    const declared = new Set((idl.events ?? []).map((event) => event.name));
    for (const name of EVENT_NAMES) {
      expect(declared.has(name), `${name} is not declared in the IDL`).toBe(
        true,
      );
    }
  });
});
