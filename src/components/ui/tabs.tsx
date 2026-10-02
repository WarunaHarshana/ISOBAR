import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex flex-col gap-3", className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("inline-flex h-11 items-center gap-1 rounded-2xl bg-white/[0.06] p-1 border border-white/[0.08] backdrop-blur-md", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-9 flex-1 items-center justify-center rounded-xl px-3 text-sm font-medium text-white/60 transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-[state=active]:bg-white/[0.14] data-[state=active]:text-white data-[state=active]:border data-[state=active]:border-white/[0.14] data-[state=active]:shadow-[0_2px_8px_rgba(0,0,0,0.35)] active:scale-[0.97] select-none",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
