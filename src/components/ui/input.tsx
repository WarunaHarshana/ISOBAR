import { cn } from "@/lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-xl bg-white/[0.05] border border-white/[0.1] px-3.5 text-sm text-[#f5f5f7] outline-none transition-all duration-200 placeholder:text-[#86868b] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(0,0,0,0.08)] focus-visible:bg-white/[0.08] focus-visible:border-apple-blue/70 focus-visible:ring-3 focus-visible:ring-apple-blue/25 disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
