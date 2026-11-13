#!/usr/bin/env node
const [baseUrl, dataDir, expectedVersion] = process.argv.slice(2);
if (process.argv.length !== 5 || !dataDir || !expectedVersion) {
  throw new Error(
    "Usage: node scripts/server/verify.mjs http://127.0.0.1:PORT DATA_DIR VERSION",
  );
}
const base = new URL(baseUrl);
if (
  base.protocol !== "http:" ||
  base.hostname !== "127.0.0.1" ||
  base.username ||
  base.password
) {
  throw new Error("Use the server's loopback HTTP URL.");
}
async function read(path) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const deadline = Date.now() + 30000;
let lastError;
while (Date.now() < deadline) {
  try {
    const [config, version, hosts] = await Promise.all([
      read("/api/v1/system/config"),
      read("/api/v1/system/version"),
      read("/api/v1/hosts"),
    ]);
    if (config?.dataDir !== dataDir)
      throw new Error(
        "A different bb data directory is answering on this port.",
      );
    if (version?.currentVersion !== expectedVersion)
      throw new Error("A different bb version is answering on this port.");
    if (
      !Array.isArray(hosts) ||
      !hosts.some(
        (host) =>
          host?.id === config.primaryHostId && host.status === "connected",
      )
    ) {
      throw new Error("The primary host daemon is not connected yet.");
    }
    console.log(
      `Verified bb ${expectedVersion}: API and primary host daemon ready.`,
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
throw lastError ?? new Error("Server verification timed out.");
