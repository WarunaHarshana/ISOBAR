/**
 * Boot the ISOBAR paper worker inside the long-lived Railway Node process.
 * Paper-only: never places live CLOB orders.
 *
 * Avoid importing nitropack/runtime — Vite/Rolldown cannot resolve it in this
 * stack and the Railway build fails. A default-export async plugin is enough.
 */
export default async function paperWorkerPlugin() {
  try {
    const mod = await import("../../src/lib/desk/paper-worker");
    mod.startPaperWorker();
  } catch (err) {
    console.error("[isobar] failed to start paper worker plugin", err);
  }
}
