import { describe, expect, test } from "bun:test";
import * as agentContract from "./agent";

describe("guided Scout setup defaults", () => {
  test("starts from the Profile role target with conservative freshness and manual runs", () => {
    const setup = (
      agentContract as typeof agentContract & {
        createDefaultScoutSetup: (roleTarget: string) => unknown;
      }
    ).createDefaultScoutSetup("AI Engineer");

    expect(setup).toEqual({
      targetRoles: ["AI Engineer"],
      discoveryAngles: ["direct_openings"],
      locations: [],
      sourceIds: [],
      listingLookbackDays: 30,
      signalLookbackDays: 7,
      verificationHours: 24,
      effort: "balanced",
      focus: "balanced",
      includeInferredOpportunities: false,
      revisitCadence: "never",
      runCadence: "manual",
      runTime: "09:00",
      additionalGuidance: "",
    });
  });

  test("preserves an unfinished comma-separated role while deriving normalized values", () => {
    const result = (
      agentContract as typeof agentContract & {
        parseScoutListDraft: (draft: string) => { draft: string; values: string[] };
      }
    ).parseScoutListDraft("AI Engineer, ");

    expect(result).toEqual({ draft: "AI Engineer, ", values: ["AI Engineer"] });
  });

  test("maps guided cadence choices to local five-field cron expressions", () => {
    const base = agentContract.createDefaultScoutSetup("AI Engineer");

    expect(agentContract.scoutCadenceCron(base)).toBeNull();
    expect(agentContract.scoutCadenceCron({ ...base, runCadence: "daily", runTime: "09:30" })).toBe(
      "30 9 * * *",
    );
    expect(
      agentContract.scoutCadenceCron({ ...base, runCadence: "weekdays", runTime: "08:05" }),
    ).toBe("5 8 * * 1-5");
    expect(
      agentContract.scoutCadenceCron({ ...base, runCadence: "weekly", runTime: "14:00" }),
    ).toBe("0 14 * * 1");
  });
});
