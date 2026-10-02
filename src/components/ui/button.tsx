import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[transform,background-color,border-color,box-shadow,color,opacity] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:not-disabled:scale-[0.97] select-none",
  {
    variants: {
      variant: {
        default: "bg-[#f5f5f7] text-[#000000] font-semibold hover:bg-white active:bg-[#e5e5ea] shadow-sm",
        secondary: "bg-white/[0.08] text-[#f5f5f7] hover:bg-white/[0.12] border border-white/[0.08] border-t-white/[0.16]",
        outline: "border border-white/[0.12] hover:border-white/[0.22] hover:bg-white/[0.05] text-[#f5f5f7]",
        glass: "bg-white/[0.05] backdrop-blur-xl border border-white/[0.08] border-t-white/[0.18] text-[#f5f5f7] hover:bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.06)]",
        ghost: "hover:bg-white/[0.06] hover:text-[#f5f5f7] text-[#86868b]",
        signal: "bg-[#30d158] text-[#000000] font-semibold hover:bg-[#34c759] shadow-[0_2px_12px_rgba(48,209,88,0.25)]",
        destructive: "bg-[#ff453a] text-white font-medium hover:bg-[#ff3b30]",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-8.5 px-3 text-xs rounded-lg",
        lg: "h-12 px-5 text-base rounded-2xl",
        icon: "size-11 rounded-xl",
        "icon-sm": "size-8.5 rounded-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
