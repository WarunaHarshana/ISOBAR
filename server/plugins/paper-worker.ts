import { defineNitroPlugin } from "nitropack/runtime";

/**
 * Boot the ISOBAR paper worker inside the long-lived Railway Node process.
 * Paper-only: never places live CLOB orders.
 */
export default defineNitroPlugin(async () => {
  try {
    const mod = await import("../../src/lib/desk/paper-worker");
    mod.startPaperWorker();
  } catch (err) {
    console.error("[isobar] failed to start paper worker plugin", err);
  }
});
