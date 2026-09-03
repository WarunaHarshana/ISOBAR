import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatUsd(n: number, digits = 2) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatCents(p: number) {
  return `${(p * 100).toFixed(1)}¢`;
}

export function formatPct(p: number, digits = 1) {
  return `${(p * 100).toFixed(digits)}%`;
}

export function formatTemp(n: number | null | undefined, unit: "C" | "F") {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}°${unit}`;
}

export function cToF(c: number) {
  return (c * 9) / 5 + 32;
}

export function fToC(f: number) {
  return ((f - 32) * 5) / 9;
}

export function convertTemp(c: number, unit: "C" | "F") {
  return unit === "F" ? cToF(c) : c;
}
