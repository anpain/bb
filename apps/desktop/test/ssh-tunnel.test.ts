import { expect, it } from "vitest";
import {
  sshLocalPort,
  sshTunnelArguments,
  sshTunnelSettingsSchema,
} from "../src/ssh-tunnel.js";

it.each([
  "https://127.0.0.1:48886",
  "http://127.0.0.1:38886",
  "http://127.0.0.1:48886/path",
  "http://192.168.1.20:48886",
])("rejects a tunnel URL outside its dedicated loopback origin: %s", (url) => {
  expect(sshLocalPort(url)).toBeNull();
});

it("requires an SSH destination and uses a foreground loopback forward", () => {
  const settings = {
    target: "bb-admin@example.net",
    identityFile: null,
    remotePort: 38887,
  };
  expect(
    sshTunnelSettingsSchema.safeParse({
      ...settings,
      target: "-oProxyCommand=anything",
    }).success,
  ).toBe(false);
  expect(sshTunnelArguments("http://127.0.0.1:48886", settings)).toEqual(
    expect.arrayContaining([
      "-N",
      "BatchMode=yes",
      "ExitOnForwardFailure=yes",
      "StrictHostKeyChecking=yes",
      "ForkAfterAuthentication=no",
      "127.0.0.1:48886:127.0.0.1:38887",
      "bb-admin@example.net",
    ]),
  );
});
