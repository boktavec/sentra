"use client";

import Link from "next/link";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SwitcherProps {
  /** Singular noun for the accessible name: "organization" gives "Switch organization". */
  noun: string;
  heading: string;
  items: { name: string; slug: string; href: string }[];
  currentSlug?: string;
  allHref: string;
  allLabel: string;
}

/**
 * Icon button that opens a short list of the user's organizations or projects (server-rendered,
 * at most 20) with a link to the full list. The current item shows its name elsewhere (sidebar,
 * breadcrumbs), so the trigger stays icon-only.
 */
export function EntitySwitcher({
  noun,
  heading,
  items,
  currentSlug,
  allHref,
  allLabel,
}: SwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`Switch ${noun}`}
        >
          <ChevronsUpDown aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-60">
        {items.length > 0 && <DropdownMenuLabel>{heading}</DropdownMenuLabel>}
        {items.map((item) => (
          <DropdownMenuItem key={item.slug} asChild>
            <Link
              href={item.href}
              title={item.name}
              aria-current={item.slug === currentSlug ? "true" : undefined}
            >
              <span className="truncate">{item.name}</span>
              {item.slug === currentSlug && <Check aria-hidden className="ml-auto size-4" />}
            </Link>
          </DropdownMenuItem>
        ))}
        {items.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem asChild>
          <Link href={allHref}>{allLabel}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
