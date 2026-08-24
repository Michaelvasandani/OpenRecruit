import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalApiServer } from "./index";

const server = new LocalApiServer({
  port: 0,
  token: "openrecruit-test-token",
  registry: { get: () => undefined },
  arbiter: {},
} as never);
let base = "";

beforeAll(async () => {
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop());

describe("OpenRecruit local API boundary", () => {
  test("keeps health but does not expose inherited market or order routes", async () => {
    const headers = { "x-opentrade-token": server.token };
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/quotes/AAPL`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/positions`, { headers })).status).toBe(404);
    expect(
      (
        await fetch(`${base}/hook/pretool-approval`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/hook/order-result`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(404);
  });
});
