import { AlertCircle, ChevronDown, ChevronRight, Coins } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "../agents/PageHeader.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { getUsage, type OrganisationUsage, type UsageReport } from "./usageApi.ts";
import { estimate, formatTokens, formatUsd, loadRates, rateFor, saveRates, type Rate, type Rates } from "./usageCost.ts";

export type Period = "this-month" | "last-month" | "last-7" | "last-30" | "custom";

const PERIODS: { value: Period; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "last-7", label: "Last 7 days" },
  { value: "last-30", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** `[from, to)` in the viewer's own time zone, so "this month" starts at their midnight. */
export function periodRange(period: Period, now: Date, customFrom: string, customTo: string): { from: Date; to: Date } | null {
  switch (period) {
    case "this-month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    case "last-month":
      return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
    case "last-7":
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    case "last-30":
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    case "custom": {
      if (!customFrom || !customTo) return null;
      const from = new Date(`${customFrom}T00:00:00`);
      const to = new Date(`${customTo}T00:00:00`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
      // The end date is inclusive: the range runs to the following midnight.
      const end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
      return end > from ? { from, to: end } : null;
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof GatewayError) return err.status === 403 ? "You don't have access to usage for this organisation." : err.message;
  return "Couldn't reach the agent service.";
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line per organisation and model — the shape a costing sheet pivots on. */
export function usageCsv(report: UsageReport, rates: Rates): string {
  const header = ["Organisation", "Organisation ID", "Model", "Calls", "Input tokens", "Output tokens", "Total tokens", "Estimated cost (USD)"];
  const lines = [header.join(",")];
  for (const org of report.organisations) {
    for (const model of org.models) {
      const cost = estimate([model], rates, report.known_prices).usd;
      lines.push(
        [org.name, org.organisation_id, model.model, model.calls, model.input_tokens, model.output_tokens, model.input_tokens + model.output_tokens, cost.toFixed(4)]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * `GET /agent/usage` — the tokens each organisation's agent runs used, so the
 * cost of running Bolty can be worked out per customer. Organisations are the
 * ones the run acted as, named from bolt-v2; each expands into its models.
 *
 * Costs are estimates: most calls come back unpriced (see `usageCost.ts`), so
 * the Rates card takes a USD-per-million rate per model, saved in this browser,
 * and every estimate follows it.
 */
export function UsageRoute() {
  const [period, setPeriod] = useState<Period>("this-month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rates, setRates] = useState<Rates>(() => loadRates());

  const range = useMemo(() => periodRange(period, new Date(), customFrom, customTo), [period, customFrom, customTo]);

  useEffect(() => {
    if (range === null) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getUsage(range.from, range.to)
      .then((body) => {
        if (!cancelled) setReport(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The range is recomputed from its inputs; `range` itself is a fresh object each render of "now".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  const known = report?.known_prices ?? {};
  const organisations = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = report?.organisations ?? [];
    return q ? rows.filter((org) => org.name.toLowerCase().includes(q) || org.organisation_id.includes(q)) : rows;
  }, [report, search]);

  const models = useMemo(() => {
    const byModel = new Map<string, { input: number; output: number }>();
    for (const org of report?.organisations ?? []) {
      for (const model of org.models) {
        const entry = byModel.get(model.model) ?? { input: 0, output: 0 };
        entry.input += model.input_tokens;
        entry.output += model.output_tokens;
        byModel.set(model.model, entry);
      }
    }
    return [...byModel.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  }, [report]);

  const total = useMemo(() => estimate((report?.organisations ?? []).flatMap((org) => org.models), rates, known), [report, rates, known]);

  function setRate(model: string, field: keyof Rate, value: string) {
    const current = rateFor(model, rates, known) ?? { input: 0, output: 0 };
    const parsed = Number(value);
    const next: Rates = { ...rates, [model]: { ...current, [field]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 } };
    setRates(next);
    saveRates(next);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function orgCost(org: OrganisationUsage): number {
    return estimate(org.models, rates, known).usd + org.document_cost_usd;
  }

  const totals = report?.totals;

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Usage"
        description="Tokens each organisation's agent runs used, with an estimated cost — for working out what Bolty costs per customer."
        actionLabel="Export CSV"
        onAction={report ? () => download(`bolty-usage-${new Date().toISOString().slice(0, 10)}.csv`, usageCsv(report, rates)) : undefined}
        actionDisabled={!report || report.organisations.length === 0}
      />
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="usage-period" className="text-muted-foreground">
              Period
            </Label>
            <NativeSelect id="usage-period" size="sm" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="min-w-40 bg-card">
              {PERIODS.map((p) => (
                <NativeSelectOption key={p.value} value={p.value}>
                  {p.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {period === "custom" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="usage-from" className="text-muted-foreground">
                  From
                </Label>
                <Input id="usage-from" type="date" className="h-8 bg-card" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="usage-to" className="text-muted-foreground">
                  To
                </Label>
                <Input id="usage-to" type="date" className="h-8 bg-card" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="ml-auto flex flex-col gap-1.5">
            <Label htmlFor="usage-search" className="text-muted-foreground">
              Organisation
            </Label>
            <Input id="usage-search" type="search" placeholder="Search by name" className="h-8 w-56 bg-card" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {loadError !== null && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {totals && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="usage-totals">
            <Card>
              <CardHeader>
                <CardDescription>Total tokens</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{formatTokens(totals.total_tokens)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {formatTokens(totals.input_tokens)} in · {formatTokens(totals.output_tokens)} out
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Agent runs</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{formatTokens(totals.runs)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">{formatTokens(report.organisations.length)} organisations</CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Estimated cost</CardDescription>
                <CardTitle className="text-2xl tabular-nums" data-testid="usage-estimate">
                  {formatUsd(total.usd + totals.document_cost_usd)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {total.unratedTokens > 0 ? `${formatTokens(total.unratedTokens)} tokens have no rate yet` : "Every model has a rate"}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Recorded by providers</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{formatUsd(totals.cost_usd + totals.document_cost_usd)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">{formatTokens(totals.unpriced_calls)} calls came back unpriced</CardContent>
            </Card>
          </div>
        )}

        {loading && report === null && loadError === null && (
          <Card aria-busy="true">
            <CardContent className="flex flex-col gap-3">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} aria-hidden="true" className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        )}

        {period === "custom" && range === null && <p className="text-sm text-muted-foreground">Pick a start and an end date.</p>}

        {report !== null && report.organisations.length === 0 && !loading && (
          <EmptyState icon={Coins} title="No usage in this period" body="No agent run used any tokens in these dates. Try a longer period." />
        )}

        {report !== null && report.organisations.length > 0 && (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Organisation</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Input tokens</TableHead>
                  <TableHead className="text-right">Output tokens</TableHead>
                  <TableHead className="text-right">Total tokens</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                  <TableHead>Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organisations.map((org) => {
                  const open = expanded.has(org.organisation_id);
                  return (
                    <Fragment key={org.organisation_id}>
                      <TableRow className="cursor-pointer" onClick={() => toggle(org.organisation_id)} data-testid="usage-org-row">
                        <TableCell>
                          <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} models for ${org.name}`} className="text-muted-foreground" onClick={(e) => { e.stopPropagation(); toggle(org.organisation_id); }}>
                            {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                          </button>
                        </TableCell>
                        <TableCell className="font-medium">
                          {org.name}
                          <div className="font-mono text-[11px] font-normal text-muted-foreground">{org.organisation_id}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(org.runs)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(org.input_tokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(org.output_tokens)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatTokens(org.total_tokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatUsd(orgCost(org))}</TableCell>
                        <TableCell className="text-muted-foreground">{formatWhen(org.last_run_at)}</TableCell>
                      </TableRow>
                      {open &&
                        org.models.map((model) => (
                          <TableRow key={`${org.organisation_id}:${model.model}`} className="bg-muted/40 text-xs" data-testid="usage-model-row">
                            <TableCell />
                            <TableCell className="font-mono">{model.model}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(model.calls)} calls</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(model.input_tokens)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(model.output_tokens)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(model.input_tokens + model.output_tokens)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatUsd(estimate([model], rates, known).usd)}</TableCell>
                            <TableCell />
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}

        {models.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Rates</CardTitle>
              <CardDescription>USD per 1 million tokens, per model. Every estimate above uses these; they are saved in this browser.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Tokens in this period</TableHead>
                    <TableHead className="w-40">Input rate</TableHead>
                    <TableHead className="w-40">Output rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map(([model, used]) => {
                    const rate = rateFor(model, rates, known);
                    return (
                      <TableRow key={model}>
                        <TableCell className="font-mono text-xs">{model}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(used.input + used.output)}</TableCell>
                        <TableCell>
                          <Input type="number" min={0} step="0.01" inputMode="decimal" aria-label={`Input rate for ${model}`} className="h-8" value={rate?.input ?? ""} placeholder="0.00" onChange={(e) => setRate(model, "input", e.target.value)} />
                        </TableCell>
                        <TableCell>
                          <Input type="number" min={0} step="0.01" inputMode="decimal" aria-label={`Output rate for ${model}`} className="h-8" value={rate?.output ?? ""} placeholder="0.00" onChange={(e) => setRate(model, "output", e.target.value)} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {report !== null && (
          <p className="text-xs text-muted-foreground">
            Counts every agent run in the console, the Ask panel and channels, by the organisation it ran as. The agent router's own call before a run is
            not recorded and is not included. Document processing cost is added to each organisation's estimate.
          </p>
        )}
      </div>
    </>
  );
}
