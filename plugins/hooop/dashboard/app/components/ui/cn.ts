import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names, then resolve Tailwind conflicts so the last-wins rule
 * holds even across variant slots (e.g. a base `px-3` and an override `px-4`
 * collapse to `px-4`, not both). `clsx` handles the conditional/array forms;
 * `twMerge` de-duplicates the Tailwind atoms. Every primitive in this folder
 * routes its final className through `cn`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
