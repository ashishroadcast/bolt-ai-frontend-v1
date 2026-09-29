import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleAlert,
  Search,
  SearchX,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PageHeader } from "../agents/PageHeader.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { listLlmConfigs, listModelCatalogue, type CatalogueModel } from "./llmConfigsApi.ts";
import {
  formatContext,
  formatPerMillion,
  perMillionNumber,
  providerOf,
} from "./ModelsRoute.pricing.ts";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

type SortKey = "name" | "id" | "context" | "input" | "output";
type SortDirection = "asc" | "desc";

/**
 * Which way each column sorts on its *first* click. The screen exists to
 * answer "what is the cheapest thing with a big context window", so that
 * question has to be one click away in each column rather than two:
 * cheapest first on a price, biggest first on a window.
 */
const FIRST_DIRECTION: Record<SortKey, SortDirection> = {
  name: "asc",
  id: "asc",
  context: "desc",
  input: "asc",
  output: "asc",
};

const COLUMN_LABEL: Record<SortKey, string> = {
  name: "Model",
  id: "Id",
  context: "Context",
  input: "Input $/1M",
  output: "Output $/1M",
};

/** Table cells sit on the card header's own inset at either edge, so a
 * column and the title above it share one vertical line. */
const CELL_X = "px-4 first:pl-6 last:pr-6";

interface Sort {
  key: SortKey;
  direction: SortDirection;
}

/**
 * Orders two numeric keys, with `null` always last. A model whose price the
 * catalogue doesn't carry — or prices at the `-1` "depends on the route"
 * sentinel (see `ModelsRoute.pricing.ts`) — is not the cheapest model; it
 * is a model with no price, and it belongs at the bottom of the column
 * whichever way the column is pointing.
 */
function compareNullable(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

function compareText(a: string, b: string, direction: SortDirection): number {
  return direction === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

function matchesSearch(model: CatalogueModel, needle: string): boolean {
  if (needle === "") return true;
  return model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
}

/** A numeric cell's value, or a quiet dash where the catalogue has none. */
function numberOrDash(value: string | null) {
  return value ?? <span className="text-muted-foreground">—</span>;
}

/**
 * The model catalogue as a reference table — Saurabh's own request, asked
 * twice: "list all relevant models with there token cost and context
 * window / open ai / anthropic / deep seek / minime / qwen / glm / etc
 * etc".
 *
 * `GET /agent/llm-configs/catalogue` has answered this since it was built,
 * and until now the only place it surfaced was a typeahead inside the "add
 * a model" form on Settings — a picker you can search but not browse,
 * which is not a list of what exists.
 *
 * **Prices are per million, converted from strings, never through a
 * float.** OpenRouter quotes USD *per token*; nobody compares models at
 * that scale. `ModelsRoute.pricing.ts` does the ×1,000,000 by shifting the
 * decimal string, and its own docstring covers why `Number(x) * 1e6` is
 * the wrong tool for a value like `2.7e-7`.
 *
 * **Every matching row renders — there is no cap, so there is nothing to
 * disclose.** 380 rows is a few thousand DOM nodes, which a table handles
 * without help, and the filter and sort are memoised so typing doesn't
 * redo that work per keystroke. A silently truncated list reads as "this
 * is all there is", and the count beside the title is the whole
 * population.
 *
 * **Configured models are marked in place rather than split onto their own
 * screen.** `listLlmConfigs()` gives the tenant's saved configs, and a
 * config's `model` field is the same OpenRouter id, so a row can say "in
 * use" where it stands. That load is independent of the catalogue's: a
 * failure on either is reported on its own and never blanks the other,
 * the same split `McpServersRoute.tsx` uses for its bindings.
 */
export function ModelsRoute() {
  const [models, setModels] = useState<CatalogueModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configuredIds, setConfiguredIds] = useState<Set<string>>(new Set());
  const [configsError, setConfigsError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  // Id ascending, because an OpenRouter id leads with its provider — so
  // the default browse order groups Anthropic's models together, then
  // DeepSeek's, then Google's, with no filter applied.
  const [sort, setSort] = useState<Sort>({ key: "id", direction: "asc" });

  useEffect(() => {
    let cancelled = false;
    listModelCatalogue()
      .then((rows) => {
        if (!cancelled) setModels(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setModels([]);
          setLoadError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listLlmConfigs()
      .then((configs) => {
        if (!cancelled) setConfiguredIds(new Set(configs.map((config) => config.model)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setConfigsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => models ?? [], [models]);

  const providers = useMemo(() => {
    const seen = new Set(rows.map((model) => providerOf(model.id)));
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter(
      (model) =>
        (provider === "" || providerOf(model.id) === provider) &&
        (!configuredOnly || configuredIds.has(model.id)) &&
        matchesSearch(model, needle),
    );

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort.key) {
        case "name":
          return compareText(a.name, b.name, sort.direction);
        case "id":
          // Provider first, then the whole id. Sorting the raw string
          // alone would file every alias id under "~" instead of beside
          // the provider it belongs to, which is the one thing this
          // column's order is for.
          return (
            compareText(providerOf(a.id), providerOf(b.id), sort.direction) ||
            compareText(a.id, b.id, sort.direction)
          );
        case "context":
          return compareNullable(
            a.context_length ?? null,
            b.context_length ?? null,
            sort.direction,
          );
        case "input":
          return compareNullable(
            perMillionNumber(a.pricing?.prompt),
            perMillionNumber(b.pricing?.prompt),
            sort.direction,
          );
        case "output":
          return compareNullable(
            perMillionNumber(a.pricing?.completion),
            perMillionNumber(b.pricing?.completion),
            sort.direction,
          );
      }
    });
    return sorted;
  }, [rows, search, provider, configuredOnly, configuredIds, sort]);

  const configuredInCatalogue = useMemo(
    () => rows.filter((model) => configuredIds.has(model.id)).length,
    [rows, configuredIds],
  );

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: FIRST_DIRECTION[key] },
    );
  }

  function sortHeader(key: SortKey, numeric = false) {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead
        // The header outlives its rows while the body scrolls — a price
        // column with no label is unreadable after the first screenful. The
        // inset shadow is its bottom rule: a collapsed table border stays
        // behind with the rows when the cell sticks.
        className={cn(
          "sticky top-0 z-10 h-10 bg-card px-2 first:pl-4 last:pr-4 shadow-[inset_0_-1px_0_var(--color-border)]",
          numeric && "text-right",
        )}
        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      >
        {/* The whole header cell is the target, so a sort is never a hunt
            for a caret two pixels wide. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "w-full px-2 font-medium",
            numeric ? "justify-end" : "justify-start",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          onClick={() => toggleSort(key)}
        >
          {COLUMN_LABEL[key]}
          <Icon className={cn("size-3.5", active ? "text-primary" : "opacity-50")} />
        </Button>
      </TableHead>
    );
  }

  const loading = models === null;

  return (
    <>
      <PageHeader
        kicker="Connections"
        title="Models"
        description="Every model the gateway can route to, with its context window and what a million tokens costs in and out."
      />

      <div className="flex flex-col gap-6">
        {loadError !== null && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Couldn't load the model catalogue</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {configsError !== null && (
          <Alert className="border-warning/30 bg-warning-soft text-warning">
            <TriangleAlert />
            <AlertTitle>Couldn't load which models you've configured</AlertTitle>
            <AlertDescription>{configsError}</AlertDescription>
          </Alert>
        )}

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="py-4">
            <h3 className="leading-none font-semibold">Catalogue</h3>
            <CardDescription className="tabular-nums" data-testid="models-count">
              {loading
                ? "Loading…"
                : visible.length === rows.length
                  ? `${rows.length} models · ${providers.length} providers`
                  : `${visible.length} of ${rows.length} models`}
            </CardDescription>
          </CardHeader>

          <div className="flex flex-col gap-3 border-t px-6 py-3 sm:flex-row sm:flex-wrap sm:items-center">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                placeholder="Search name or id…"
                aria-label="Search models"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </InputGroup>
            {/* A provider is an id fragment, so it is shown in the id's own
                voice. */}
            <NativeSelect
              aria-label="Filter by provider"
              className="font-mono text-xs"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <NativeSelectOption value="">All providers</NativeSelectOption>
              {providers.map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <div className="flex items-center gap-2">
              <Checkbox
                id="models-configured-only"
                checked={configuredOnly}
                onCheckedChange={(checked) => setConfiguredOnly(checked === true)}
              />
              <Label htmlFor="models-configured-only" className="font-normal tabular-nums">
                Configured only ({configuredInCatalogue})
              </Label>
            </div>
          </div>

          {/* 380 rows deep and five columns wide: the page scrolls
              vertically, and only this box scrolls sideways when a long id
              needs the room. */}
          <div className="max-h-[68vh] overflow-auto border-t">
            <table data-slot="table" className="w-full caption-bottom text-sm">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {sortHeader("name")}
                  {sortHeader("id")}
                  {sortHeader("context", true)}
                  {sortHeader("input", true)}
                  {sortHeader("output", true)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading &&
                  [0, 1, 2, 3, 4, 5].map((i) => (
                    <TableRow key={i} className="hover:bg-transparent">
                      <TableCell className={cn(CELL_X, "py-3")}>
                        <Skeleton className="h-4 w-40" />
                      </TableCell>
                      <TableCell className={cn(CELL_X, "py-3")}>
                        <Skeleton className="h-4 w-48" />
                      </TableCell>
                      {[0, 1, 2].map((j) => (
                        <TableCell key={j} className={cn(CELL_X, "py-3")}>
                          <Skeleton className="ml-auto h-4 w-12" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {visible.map((model) => (
                  <TableRow key={model.id} className="even:bg-muted/30">
                    <TableCell className={cn(CELL_X, "py-2")}>
                      {/* The two text columns are capped so the three
                          numeric ones — the point of the screen — are never
                          the columns pushed off the right edge. */}
                      <div className="flex max-w-[30ch] items-center gap-2">
                        <span className="min-w-0 truncate font-medium" title={model.name}>
                          {model.name}
                        </span>
                        {/* Already configured on Settings. A quiet badge,
                            not a colour on the row — this marks a fact
                            about the tenant, not a state of the model. */}
                        {configuredIds.has(model.id) && (
                          <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary">
                            in use
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cn(CELL_X, "py-2")}>
                      {/* An id is a value to read and copy, so it scrolls
                          inside its own cell rather than being clipped. */}
                      <code className="block max-w-[32ch] overflow-x-auto font-mono text-xs text-muted-foreground">
                        {model.id}
                      </code>
                    </TableCell>
                    <TableCell className={cn(CELL_X, "py-2 text-right font-mono tabular-nums")}>
                      {numberOrDash(formatContext(model.context_length))}
                    </TableCell>
                    <TableCell className={cn(CELL_X, "py-2 text-right font-mono tabular-nums")}>
                      {numberOrDash(formatPerMillion(model.pricing?.prompt))}
                    </TableCell>
                    <TableCell className={cn(CELL_X, "py-2 text-right font-mono tabular-nums")}>
                      {numberOrDash(formatPerMillion(model.pricing?.completion))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>

          {!loading && visible.length === 0 && (
            <div className="flex flex-col items-center gap-2 border-t px-4 py-10 text-center text-sm text-muted-foreground">
              <SearchX className="size-5" />
              <p>
                {rows.length === 0
                  ? "The catalogue came back empty."
                  : "No model matches these filters."}
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
