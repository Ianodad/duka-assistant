import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** shadcn/ui-style Button, copied into the repo and restyled with Duka tokens. */
export const buttonVariants = cva(
  'pressable inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-board text-white hover:bg-board-strong',
        sun: 'bg-sun text-ink hover:bg-[#ecb92b]',
        outline: 'border border-field bg-surface text-ink hover:border-ink',
        ghost: 'text-ink hover:bg-board-soft',
        mpesa: 'bg-mpesa text-white hover:bg-mpesa-strong',
        chip: 'border border-line bg-surface text-ink hover:border-board hover:text-board',
      },
      size: {
        sm: 'h-9 rounded-full px-3.5 text-sm',
        md: 'h-11 rounded-xl px-4 text-[15px]',
        lg: 'h-13 rounded-2xl px-5 text-base',
        icon: 'size-11 rounded-full',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
