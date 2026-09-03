import { getWorkerStatus, startPaperWorker } from "../../src/lib/desk/paper-worker";
import { loadPaperBook } from "../../src/lib/desk/paper-book";

export default defineEventHandler(() => {
  startPaperWorker();
  const worker = getWorkerStatus();
  const book = loadPaperBook();
  return {
    ok: true,
    worker: {
      running: worker.running,
      armed: worker.armed,
      lastTickAt: worker.lastTickAt,
      openFills: worker.openFills,
      liveLocked: worker.liveLocked,
      ticks: worker.ticks,
    },
    openFills: book.fills.filter((f) => f.status === "open").length,
  };
});
