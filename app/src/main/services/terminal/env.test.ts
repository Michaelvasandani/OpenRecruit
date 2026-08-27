import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentEnv } from "./env";

describe("buildAgentEnv — subscription auth", () => {
  let prev: string | undefined;
  let prevFirecrawl: string | undefined;
  let prevBirdPath: string | undefined;
  beforeEach(() => {
    prev = process.env.ANTHROPIC_API_KEY;
    prevFirecrawl = process.env.FIRECRAWL_API_KEY;
    prevBirdPath = process.env.OPENRECRUIT_BIRD_PATH;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.FIRECRAWL_API_KEY = "fc-agent-env-secret";
    process.env.OPENRECRUIT_BIRD_PATH = "/private/bird";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
    if (prevFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = prevFirecrawl;
    if (prevBirdPath === undefined) delete process.env.OPENRECRUIT_BIRD_PATH;
    else process.env.OPENRECRUIT_BIRD_PATH = prevBirdPath;
  });

  test("strips the harness's API keys when subscription auth is on (background runs)", () => {
    const env = buildAgentEnv("a1", undefined, { stripEnvKeys: ["ANTHROPIC_API_KEY"] });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("keeps ANTHROPIC_API_KEY when no strip list is given", () => {
    const env = buildAgentEnv("a1", undefined, { stripEnvKeys: [] });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  test("keeps the key by default (no opts) — the interactive path is untouched", () => {
    const env = buildAgentEnv("a1");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    // Sanity: OPENTRADE identifiers are still injected.
    expect(env.OPENTRADE_AGENT_ID).toBe("a1");
  });

  test("never passes the host-owned Firecrawl credential to an agent environment", () => {
    const env = buildAgentEnv("a1");
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
    expect(
      buildAgentEnv("a1", { FIRECRAWL_API_KEY: "fc-extra-secret" }).FIRECRAWL_API_KEY,
    ).toBeUndefined();
  });

  test("never passes the host-only Bird path override to a Scout environment", () => {
    expect(buildAgentEnv("a1").OPENRECRUIT_BIRD_PATH).toBeUndefined();
    expect(
      buildAgentEnv("a1", { OPENRECRUIT_BIRD_PATH: "/attempted/override" }).OPENRECRUIT_BIRD_PATH,
    ).toBeUndefined();
  });
});
