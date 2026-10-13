"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FILTER_BAR_CLASS } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { KNOWN_AUDIT_ACTIONS } from "@/lib/audit-actions";
import { issueId, utcQueryFromForm, type FilterField, type FilterIssue } from "@/lib/audit-filters";
import type { AuditFilters } from "@/lib/audits";
import { cn } from "@/lib/utils";
import { toLocalInputValue } from "@/lib/local-time";

const HINT_ID = "audit-timezone-hint";

function Field({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** `aria-invalid` and a description link for a field with a validation issue. */
function invalidProps(issues: FilterIssue[], field: FilterField, extra?: string) {
  const issue = issues.some((candidate) => candidate.field === field);

  return {
    "aria-invalid": issue || undefined,
    "aria-describedby": [issue && issueId(field), extra].filter(Boolean).join(" ") || undefined,
  };
}

type FieldValues = Record<FilterField, string>;

/** Server (UTC) values until mount, so hydration matches; From/To switch to local time after. */
const EMPTY_VALUES: FieldValues = { from: "", to: "", actorId: "", action: "", result: "" };

const utcInput = (iso = "") => iso.slice(0, 19);

const serverValues = (filters: AuditFilters): FieldValues => ({
  ...EMPTY_VALUES,
  ...filters,
  from: utcInput(filters.from),
  to: utcInput(filters.to),
});

const localValues = (filters: AuditFilters): FieldValues => ({
  ...serverValues(filters),
  from: filters.from ? toLocalInputValue(filters.from) : "",
  to: filters.to ? toLocalInputValue(filters.to) : "",
});

/**
 * Controlled field values that follow the URL (Clear filters, pagination) without remounting the
 * form, so keyboard focus survives a submit.
 */
function useFieldValues(filters: AuditFilters) {
  const [values, setValues] = useState(serverValues(filters));
  const [timeZone, setTimeZone] = useState<string>();

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setValues(localValues(filters));
  }, [filters]);

  const bind = (field: FilterField) => ({
    name: field,
    value: values[field],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
  });

  return { bind, timeZone };
}

/** After a submit that failed validation, put focus on the first offending field. */
function useFocusFirstIssue(form: RefObject<HTMLFormElement | null>, issues: FilterIssue[]) {
  useEffect(() => {
    const field = issues[0]?.field;

    if (field) form.current?.querySelector<HTMLElement>(`[name=${field}]`)?.focus();
  }, [form, issues]);
}

/** Writes From/To as strict UTC ISO into the URL (a `datetime-local` value has no zone). */
function useUtcSubmit() {
  const router = useRouter();
  const pathname = usePathname();

  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = utcQueryFromForm(new FormData(event.currentTarget));

    router.push(query ? `${pathname}?${query}` : pathname);
  };
}

export function AuditFilterForm({
  filters,
  issues,
  canClear,
}: {
  filters: AuditFilters;
  issues: FilterIssue[];
  canClear: boolean;
}) {
  const { bind, timeZone } = useFieldValues(filters);
  const formRef = useRef<HTMLFormElement>(null);

  useFocusFirstIssue(formRef, issues);
  const onSubmit = useUtcSubmit();
  const pathname = usePathname();

  return (
    <form ref={formRef} method="get" onSubmit={onSubmit} className={FILTER_BAR_CLASS}>
      <Field id="audit-from" label="From" className="w-full sm:w-64">
        <Input
          id="audit-from"
          {...bind("from")}
          type="datetime-local"
          step={1}
          {...invalidProps(issues, "from", HINT_ID)}
        />
      </Field>
      <Field id="audit-to" label="To" className="w-full sm:w-64">
        <Input
          id="audit-to"
          {...bind("to")}
          type="datetime-local"
          step={1}
          {...invalidProps(issues, "to", HINT_ID)}
        />
      </Field>
      <Field id="audit-actor" label="Actor ID" className="w-full sm:w-80">
        <Input
          id="audit-actor"
          {...bind("actorId")}
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          {...invalidProps(issues, "actorId")}
        />
      </Field>
      <Field id="audit-action" label="Action" className="w-full sm:w-56">
        <Input
          id="audit-action"
          {...bind("action")}
          list="audit-actions"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          {...invalidProps(issues, "action")}
        />
        <datalist id="audit-actions">
          {KNOWN_AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      </Field>
      <Field id="audit-result" label="Result" className="w-full sm:w-36">
        <NativeSelect id="audit-result" {...bind("result")}>
          <option value="">All</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </NativeSelect>
      </Field>
      <Button type="submit" variant="secondary" size="sm">
        Filter
      </Button>
      {canClear && (
        <Button asChild variant="ghost" size="sm">
          <Link href={pathname}>Clear filters</Link>
        </Button>
      )}
      <p id={HINT_ID} className="min-h-4 basis-full text-xs leading-4 text-muted-foreground">
        {timeZone ? `Times in your time zone (${timeZone})` : "Times in UTC"}
      </p>
    </form>
  );
}
