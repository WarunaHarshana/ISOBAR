import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "bg-white/[0.08] text-[#86868b] border border-white/[0.08]",
        signal: "bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 font-semibold",
        warn: "bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 font-semibold",
        danger: "bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30 font-semibold",
        blue: "bg-[#0a84ff]/15 text-[#64d2ff] border border-[#0a84ff]/30 font-semibold",
        outline: "bg-white/[0.03] text-white/70 border border-white/[0.12]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
