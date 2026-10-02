import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-white/[0.1] bg-white/[0.15] p-0.5 transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-[state=checked]:bg-[#30d158] data-[state=checked]:border-[#30d158] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/70 active:scale-[0.96]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5.5 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
