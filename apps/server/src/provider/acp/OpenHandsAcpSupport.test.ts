import { describe, expect, it } from "@effect/vitest";

import {
  OPENHANDS_ALWAYS_APPROVE_MODE_ID,
  OPENHANDS_ALWAYS_ASK_MODE_ID,
  OPENHANDS_LLM_APPROVE_MODE_ID,
  buildOpenHandsAcpSpawnInput,
  openHandsAcpModeId,
  openHandsAcpSpawnArgs,
  resolveOpenHandsAcpBaseModelId,
} from "./OpenHandsAcpSupport.ts";

describe("resolveOpenHandsAcpBaseModelId", () => {
  it("falls back to the built-in slug when no custom model id is set", () => {
    expect(resolveOpenHandsAcpBaseModelId(undefined)).toBe("openhands-default");
    expect(resolveOpenHandsAcpBaseModelId(null)).toBe("openhands-default");
    expect(resolveOpenHandsAcpBaseModelId("  ")).toBe("openhands-default");
  });

  it("trims and keeps an explicit model id", () => {
    expect(resolveOpenHandsAcpBaseModelId(" openhands-custom-model ")).toBe(
      "openhands-custom-model",
    );
  });
});

describe("openHandsAcpModeId", () => {
  it("defaults to always-ask when no runtime mode is set", () => {
    expect(openHandsAcpModeId(undefined)).toBe(OPENHANDS_ALWAYS_ASK_MODE_ID);
  });

  it("maps approval-required to always-ask", () => {
    expect(openHandsAcpModeId("approval-required")).toBe(OPENHANDS_ALWAYS_ASK_MODE_ID);
  });

  it("maps auto-accept-edits and auto onto the LLM security analyzer", () => {
    expect(openHandsAcpModeId("auto-accept-edits")).toBe(OPENHANDS_LLM_APPROVE_MODE_ID);
    expect(openHandsAcpModeId("auto")).toBe(OPENHANDS_LLM_APPROVE_MODE_ID);
  });

  it("maps full-access to always-approve", () => {
    expect(openHandsAcpModeId("full-access")).toBe(OPENHANDS_ALWAYS_APPROVE_MODE_ID);
  });
});

describe("openHandsAcpSpawnArgs", () => {
  it("has no flag for the always-ask default", () => {
    expect(openHandsAcpSpawnArgs()).toEqual(["acp"]);
    expect(openHandsAcpSpawnArgs("approval-required")).toEqual(["acp"]);
  });

  it("passes --llm-approve for auto-accept-edits and auto", () => {
    expect(openHandsAcpSpawnArgs("auto-accept-edits")).toEqual(["acp", "--llm-approve"]);
    expect(openHandsAcpSpawnArgs("auto")).toEqual(["acp", "--llm-approve"]);
  });

  it("passes --always-approve for full-access", () => {
    expect(openHandsAcpSpawnArgs("full-access")).toEqual(["acp", "--always-approve"]);
  });
});

describe("buildOpenHandsAcpSpawnInput", () => {
  it("defaults to the `openhands` binary and suppresses the startup banner", () => {
    const spawn = buildOpenHandsAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.command).toBe("openhands");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env?.OPENHANDS_SUPPRESS_BANNER).toBe("1");
  });

  it("honors a configured binary path override", () => {
    const spawn = buildOpenHandsAcpSpawnInput(
      { binaryPath: "/usr/local/bin/openhands" },
      "/tmp/project",
    );
    expect(spawn.command).toBe("/usr/local/bin/openhands");
  });

  it("merges the caller's environment and preserves the runtime mode flag", () => {
    const spawn = buildOpenHandsAcpSpawnInput(
      undefined,
      "/tmp/project",
      { FOO: "bar" },
      "full-access",
    );
    expect(spawn.args).toEqual(["acp", "--always-approve"]);
    expect(spawn.env?.FOO).toBe("bar");
    expect(spawn.env?.OPENHANDS_SUPPRESS_BANNER).toBe("1");
  });
});
