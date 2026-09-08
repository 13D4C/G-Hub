import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const cardVariants = cva("rounded-3xl", {
  variants: {
    variant: {
      solid: "bg-white shadow-xl",
      glass: "border border-white/20 bg-white/10 shadow-2xl backdrop-blur-xl",
    },
  },
  defaultVariants: {
    variant: "solid",
  },
})

function Card({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />
  )
}

export { Card, cardVariants }
