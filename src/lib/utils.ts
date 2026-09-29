import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names, letting a later Tailwind class override an earlier one
 * (`cn("px-2", props.className)`) — shadcn's convention for every component. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
