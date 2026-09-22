import { createFileRoute } from "@tanstack/react-router";
import { CloudSun } from "lucide-react";
import { fetchDeskSnapshot } from "@/lib/desk/server";
import { DeskApp } from "@/components/desk/desk-app";

export const Route = createFileRoute("/")({
  loader: () => fetchDeskSnapshot(),
  component: Home,
  pendingComponent: DeskPending,
});

function Home() {
  const snapshot = Route.useLoaderData();
  return <DeskApp initial={snapshot} />;
}

function DeskPending() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background text-foreground antialiased selection:bg-apple-blue/30 selection:text-white p-6">
      <div className="flex size-14 items-center justify-center rounded-3xl bg-gradient-to-b from-[#0a84ff] to-[#0055b3] text-white shadow-[0_8px_24px_rgba(10,132,255,0.4)] ring-1 ring-white/25 animate-pulse">
        <CloudSun className="size-7" strokeWidth={2} />
      </div>
      <div className="text-center">
        <p className="font-sans text-base font-semibold tracking-[-0.025em] text-white">ISOBAR</p>
        <p className="mt-1 text-xs text-[#86868b] tracking-normal">Connecting to live weather and prediction markets…</p>
      </div>
    </main>
  );
}
