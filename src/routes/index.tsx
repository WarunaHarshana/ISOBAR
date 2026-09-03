import { createFileRoute } from "@tanstack/react-router";
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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
      <p className="font-sans text-sm tracking-[0.22em]">ISOBAR</p>
      <p className="text-sm text-muted-foreground">Loading live weather markets…</p>
    </main>
  );
}
