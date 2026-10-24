import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "sp-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-fire-500/70 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-board-bg aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border border-fire-600/60 bg-fire-500 text-black shadow-[inset_0_1px_0_#ffffff40,0_1px_2px_#00000020] hover:bg-fire-400 hover:border-fire-400",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border border-board-border bg-board-card/50 text-board-text shadow-[inset_0_1px_0_#ffffff05] hover:border-board-muted/50 hover:bg-board-card",
        secondary:
          "border border-board-border bg-board-card text-board-text shadow-[inset_0_1px_0_#ffffff08] hover:bg-board-border",
        ghost:
          "text-board-muted hover:bg-board-text/5 hover:text-board-text",
        link: "text-board-text underline-offset-4 hover:underline decoration-fire-500",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
