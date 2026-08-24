import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalApiServer } from "./index";

const server = new LocalApiServer({
  registry: { get: () => undefined },
  arbiter: {},
} as never);
let base = "";

beforeAll(async () => {
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop());

describe("authenticated local API", () => {
  test("/health needs no token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  test("rejects missing token", async () => {
    const res = await fetch(`${base}/quotes/AAPL`);
    expect(res.status).toBe(401);
  });

  test("does not expose inherited market-data routes", async () => {
    const headers = { "x-opentrade-token": server.token };
    expect((await fetch(`${base}/quotes/AAPL`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/positions`, { headers })).status).toBe(404);
  });
});
