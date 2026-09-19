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

describe("buildAgentEnv — enclosing Claude session", () => {
  const AMBIENT = {
    CLAUDECODE: "1",
    CLAUDE_PID: "79664",
    CLAUDE_CODE_SESSION_ID: "parent-session",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_HOST_SESSION_ID: "local_parent",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/79664.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
  };
  const USER_OWNED = { CLAUDE_CONFIG_DIR: "/custom/claude", CLAUDE_CODE_USE_BEDROCK: "1" };
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const key of [...Object.keys(AMBIENT), ...Object.keys(USER_OWNED)]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("never lets a Scout inherit the identity of the Claude session that launched the host", () => {
    Object.assign(process.env, AMBIENT, USER_OWNED);

    const env = buildAgentEnv("a1");

    for (const key of Object.keys(AMBIENT)) expect(env[key]).toBeUndefined();
    expect(env).toMatchObject(USER_OWNED);
  });

  test("keeps a user's own API base URL when no Claude session encloses the host", () => {
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";

    expect(buildAgentEnv("a1").ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
  });
});
