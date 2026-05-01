/**
 * FindHost — React shell mounted in vellum's Find tab slot.
 *
 * Mirrors `KanbanHost`'s pattern: a portolan-owned shell that mounts inside
 * vellum's tab slot, lazy on tab-enter. Stage A landed the empty shell;
 * Stages B + F filled in the cross-project Fibers tree and the per-city Git
 * status; Stage K refactored the dashboard to the spatial grid; Stage C+E
 * wired search + Files column. **Stage D (this file)** fills in the Cities
 * column: every pinned local city as a row with its workers nested
 * underneath. Clicking a city re-scopes Find in place (no map move);
 * clicking a worker focuses its kitty tab via the `onOpenWorker` plumb.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ FIND · scope: <…>                       [⊕ Global][Refresh]│  eyebrow
 *   │ ⌕ search fibers + files…                                  │  search bar
 *   ├──────────┬───────────────────────┬────────────────────────┤
 *   │ CITIES   │ FIBERS  (Stage B)     │ FILES (Stage E)        │
 *   │ ⬢ city₁  │                       │                        │
 *   │  🐦 wkr₁ │                       │                        │
 *   ├──────────┴───────────┬───────────┴────────────────────────┤
 *   │ GIT  (Stage F)       │ RECENTS (Stage G)                  │
 *   └──────────────────────┴────────────────────────────────────┘
 *
 * Two scope axes coexist. The **modal scope** is the cityId the modal
 * was opened with (props.cityId); it doesn't change once the modal is
 * up. The **find scope** (`localScopeCityId`) is the in-Find scope —
 * what the eyebrow displays, which city's group auto-expands in Fibers,
 * which city pre-loads in Files, which city pins to the top in Git.
 * It initializes from the modal scope and re-syncs when the prop
 * changes; clicking a city in the Cities column updates it without
 * touching props or the map camera. That separation is the
 * constitution's "Cities click re-scopes Find in place" decision: two
 * intents (`v`/map hex = "go there", camera moves; Cities-column click
 * = "check on there", only Find scope flips).
 *
 * Click-throughs in any section honour the source-city of the clicked
 * row (vellum pivots cross-city), so re-scoping doesn't constrain what
 * the user can open — only what they're presented with by default.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { score as fzyScore, hasMatch as fzyHasMatch } from 'fzy.js'
import { fiberStatusIcon } from '../ui/utils'
import { getPortolanMountContext } from './mount'
import { FIND_FOCUS_SEARCH_EVENT, FIND_SEARCH_INPUT_CLASS } from './find-shared'
import { FindFilesSection } from './FindFilesSection'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

// Re-export so existing callers that previously imported these from FindHost
// (Stage K touched files) keep working without a churn-only change set.
export { FIND_FOCUS_SEARCH_EVENT, FIND_SEARCH_INPUT_CLASS }

/** Wire shape from `GET /global-fibers` — must match
 *  `server/src/HttpApiGlobalSearch.ts` `GlobalFiberNode`. */
interface GlobalFiberNode {
  id: string
  loomId?: string
  name: string
  status: string
  kind: string
  tags: string[]
  outcome?: string
  parentId: string | null
  hasChildren: boolean
}

/** Subset of `state/types.ts:GitStatus` — what the Git section renders.
 *  Mirrors what `PortolanMountContext.getCities()` exposes; kept structural
 *  here so `FindHost` doesn't import portolan state types directly. */
interface CityGitStatus {
  branch: string
  ahead: number
  behind: number
  staged: { added: number; modified: number; deleted: number }
  unstaged: { added: number; modified: number; deleted: number }
  untracked: number
  linesAdded: number
  linesRemoved: number
  lastCommitTime: number | null
  lastCommitMessage: string | null
  isRepo: boolean
}

/** Per-city row used by the Git section. Built from the mount context's
 *  city list; only local cities populate this (remote cities don't carry
 *  git status across the snapshot wire). */
interface GitSectionCity {
  cityId: string
  displayName: string
  gitStatus?: CityGitStatus
}

/** Wire shape from `GET /global-fibers` — must match
 *  `server/src/HttpApiGlobalSearch.ts` `GlobalFiberCityGroup`. */
interface GlobalFiberCityGroup {
  cityId?: string
  originId: string
  hostname?: string
  isStale: boolean
  staleSince?: string
  fibers: GlobalFiberNode[]
}

interface GlobalFibersResponse {
  cities: GlobalFiberCityGroup[]
  generatedAt: number
}

export function FindHost({
  cityId,
  cityName,
  onOpenWorker,
  onOpenFiberInCity,
}: {
  cityId?: string
  cityName?: string
  /** Stage D click-through for the Cities column's nested workers. Forwards
   *  the worker's tmux session name to main.ts, which resolves it to a
   *  Session and focuses the matching kitty tab (and pivots the camera).
   *  Optional — when omitted, clicks are no-ops with a console warning. */
  onOpenWorker?: (tmuxSessionName: string) => void
  /** Stage B click-through: pivot vellum to the city that owns a fiber.
   *  main.ts already resolves `cityId` → City and reopens vellum scoped
   *  to it (closing the current modal first), with the fiber selected.
   *  Optional — when omitted (no global-search consumer was wired) clicks
   *  are no-ops, but the constitution requires this path for Find. */
  onOpenFiberInCity?: (cityId: string, slug: string) => void
}) {
  const [data, setData] = useState<GlobalFibersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Re-fetch counter; bumping it triggers the effect below. Used by the
  // refresh button and by future stages that want to rehydrate after a
  // stash creates a new fiber. Initial mount fetches once.
  const [refreshTick, setRefreshTick] = useState(0)

  /**
   * Search query state. Lifted to FindHost; Stages C+E wire it so when
   * non-empty, the Fibers + Files columns flatten into a single combined
   * ranked list (kind + origin badges per row). Empty input shows the
   * trees in both columns.
   */
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Debounced query — only the trailing edge of typing triggers HTTP
  // fetches against /global-search + /global-files-search. 110ms matches
  // the predecessor `/` palette's debounce (retired in Stage C+E), which
  // felt right for fast typers without leaving lag visible.
  const debouncedQuery = useDebouncedValue(query.trim(), 110)
  const isSearching = debouncedQuery.length > 0
  const combined = useCombinedSearch(debouncedQuery)

  // Listen for the `/` hotkey's focus request. Dispatched by main.ts when
  // the user wants to focus the search input from outside FindHost (e.g.,
  // pressing `/` while vellum is already on Find). Window-level so we hear
  // it regardless of which descendant currently owns focus.
  useEffect(() => {
    const handler = (): void => {
      const el = searchInputRef.current
      if (!el) return
      el.focus()
      el.select()
    }
    window.addEventListener(FIND_FOCUS_SEARCH_EVENT, handler)
    return () => window.removeEventListener(FIND_FOCUS_SEARCH_EVENT, handler)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${API_BASE}/global-fibers`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`global-fibers ${res.status}`)
        return (await res.json()) as GlobalFibersResponse
      })
      .then((payload) => {
        if (cancelled) return
        setData(payload)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = (err as { message?: string })?.message ?? String(err)
        console.error('[FindHost] /global-fibers failed:', msg)
        setError(msg)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  // FindHost re-reads frontend state on a slow tick so cityById,
  // gitCities, and the Files-column city list pick up state-sync pushes
  // (city pinning, gitStatus poll, mock-fallback → real cities) without
  // wiring a custom subscription. The mount context is module-scoped, so
  // tying re-reads to a tick keeps the React-tree reactive while leaving
  // the actual subscription mechanics inside main.ts.
  const [stateTick, setStateTick] = useState(0)
  useEffect(() => {
    const handle = window.setInterval(() => setStateTick((n) => n + 1), 1500)
    return () => window.clearInterval(handle)
  }, [])

  // Read cities once per render via the live mount context. Used by
  // multiple sections downstream so we materialize once rather than
  // re-reading at each call site.
  const portolanCities = useMemo(() => {
    const ctx = getPortolanMountContext()
    return ctx ? ctx.getCities() : []
    // stateTick + refreshTick + data drive the memo so a state-sync push
    // or a /global-fibers refresh pulls fresh values without a one-off
    // signal per consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateTick, refreshTick, data])

  // Resolve city name + path + gitStatus for any cityId in the response.
  // Re-reads on every refresh tick so the Git section reflects the latest
  // poll result; re-reads on stateTick so a transition from mock fallback
  // → real cities (e.g., cold load) doesn't strand stale display names.
  const cityById = useMemo(() => {
    return new Map(portolanCities.map((c) => [c.id, c]))
  }, [portolanCities])

  // Find scope — the in-Find scope the user can flip in place via the
  // Cities column. Distinct from props.cityId (the modal's outer scope,
  // which decides which adapter the host opened against). Initialized
  // from the prop and re-synced when the prop changes (cold open with
  // a different focused city); user clicks on Cities-column rows
  // override locally without touching props or the map camera.
  const [localScopeCityId, setLocalScopeCityId] = useState<string | undefined>(cityId)
  useEffect(() => {
    setLocalScopeCityId(cityId)
  }, [cityId])

  // Resolve the scope-city's display name from cityById. Falls back to
  // the modal's cityName prop when the user hasn't re-scoped (the
  // initial state where localScopeCityId === cityId), then to path
  // basename, then to the bare cityId. Keeps the eyebrow honest for
  // any scope the user reaches.
  const scopedCityName = useMemo<string | undefined>(() => {
    if (!localScopeCityId) return undefined
    if (localScopeCityId === cityId && cityName) return cityName
    const meta = cityById.get(localScopeCityId)
    return meta?.name ?? meta?.path?.split('/').pop() ?? localScopeCityId
  }, [localScopeCityId, cityId, cityName, cityById])

  // Build the row list for the Git section: every local city we know about,
  // sorted with the scoped city first then alphabetical. Remote cities are
  // omitted — gitStatus doesn't ride the snapshot wire today. We render the
  // section regardless (so a "no git" empty-state surfaces) but only iterate
  // local cities for rows.
  const gitCities = useMemo<GitSectionCity[]>(() => {
    const rows: GitSectionCity[] = []
    for (const c of portolanCities) {
      if (c.originId !== 'local') continue
      const displayName = c.name ?? c.path.split('/').pop() ?? c.id
      rows.push({ cityId: c.id, displayName, gitStatus: c.gitStatus })
    }
    rows.sort((a, b) => {
      if (localScopeCityId) {
        if (a.cityId === localScopeCityId && b.cityId !== localScopeCityId) return -1
        if (b.cityId === localScopeCityId && a.cityId !== localScopeCityId) return 1
      }
      return a.displayName.localeCompare(b.displayName)
    })
    return rows
  }, [localScopeCityId, portolanCities])

  // Sections collapse/expand state, indexed by stable group key. Default:
  // every group collapsed except the scoped city's, which auto-expands
  // on first render so the user lands on something usable.
  const [openCityKeys, setOpenCityKeys] = useState<Set<string>>(() =>
    cityId ? new Set([`local::${cityId}`]) : new Set(),
  )
  // Per-fiber expanded state for the "one expand level" the constitution
  // permits in the Find trees. Keyed by `${groupKey}::${fiberId}` so two
  // cities with the same project-relative slug don't collide.
  const [openFiberKeys, setOpenFiberKeys] = useState<Set<string>>(new Set())

  // If the find scope changes (Cities-column click, or the modal's
  // outer scope flipped), auto-expand the new one in the Fibers tree.
  // Don't collapse the previously-open city — the user might still
  // want to see it; this matches the kanban tab's "additive" feel.
  useEffect(() => {
    if (!localScopeCityId) return
    setOpenCityKeys((prev) => {
      const key = `local::${localScopeCityId}`
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [localScopeCityId])

  return (
    <div
      className="find-host"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        overflow: 'auto',
        background: 'var(--surface, #FBF8F3)',
        color: 'var(--text, #2A2118)',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          maxWidth: '88rem',
          margin: '0 auto',
          padding: '1.75rem 1.5rem 4rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <Eyebrow
          scopedCityName={scopedCityName}
          showClearScope={!!localScopeCityId}
          onClearScope={() => setLocalScopeCityId(undefined)}
          onRefresh={() => setRefreshTick((n) => n + 1)}
        />
        <SearchBar
          inputRef={searchInputRef}
          value={query}
          onChange={setQuery}
        />
        <div
          className="find-grid-top"
          style={{
            // Cities (sidebar) | Fibers (workhorse) | Files (workhorse).
            // The two right columns split evenly; Cities is narrow because
            // it's a city list, not a workspace.
            display: 'grid',
            gridTemplateColumns: 'minmax(13rem, 14rem) minmax(0, 1fr) minmax(0, 1fr)',
            gap: '1rem',
            alignItems: 'start',
          }}
        >
          <CitiesColumn
            cities={portolanCities}
            scopedCityId={localScopeCityId}
            onScopeCity={setLocalScopeCityId}
            onOpenWorker={onOpenWorker}
            query={debouncedQuery}
          />
          {isSearching ? (
            // Constitution §"Find layout" — non-empty input collapses the
            // Fibers + Files columns into one combined ranked list. The
            // grid keeps Cities in its column on the left; the results
            // span the remaining two grid columns so we don't reflow the
            // whole layout on every keystroke.
            <CombinedResultsSection
              query={debouncedQuery}
              loading={combined.loading}
              error={combined.error}
              fiberHits={combined.fiberHits}
              fileHits={combined.fileHits}
              cityById={cityById}
              onOpenFiberInCity={onOpenFiberInCity}
            />
          ) : (
            <>
              <FibersSection
                loading={loading}
                error={error}
                data={data}
                cityById={cityById}
                focusedCityId={localScopeCityId}
                openCityKeys={openCityKeys}
                setOpenCityKeys={setOpenCityKeys}
                openFiberKeys={openFiberKeys}
                setOpenFiberKeys={setOpenFiberKeys}
                onOpenFiberInCity={onOpenFiberInCity}
              />
              <FilesColumn cityId={localScopeCityId} cities={portolanCities} />
            </>
          )}
        </div>
        <div
          className="find-grid-footer"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '1rem',
            alignItems: 'start',
          }}
        >
          <GitSection cities={gitCities} focusedCityId={localScopeCityId} />
          <RecentsSection
            focusedCityId={localScopeCityId}
            cities={portolanCities}
            refreshTick={refreshTick}
            onOpenFiberInCity={onOpenFiberInCity}
          />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * Eyebrow — scope label + small refresh button. Mirrors the metadata-row
 * convention vellum uses on its own pages so the Find tab feels like part
 * of the same surface rather than a stranger overlay.
 * ------------------------------------------------------------------------ */

function Eyebrow({
  scopedCityName,
  showClearScope,
  onClearScope,
  onRefresh,
}: {
  /** Resolved city display name when scoped; undefined for global scope. */
  scopedCityName: string | undefined
  /** True iff a "scope back to global" affordance should render. Mirrors
   *  `localScopeCityId !== undefined`; pulled out so the Eyebrow renders
   *  the action without re-resolving state. */
  showClearScope: boolean
  /** Reset the in-Find scope to global. Counterpart to clicking the All
   *  cities row in the Cities column; here for users who navigate
   *  primarily through the eyebrow. */
  onClearScope: () => void
  onRefresh: () => void
}): JSX.Element {
  const scope = scopedCityName ?? 'global'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          opacity: 0.6,
        }}
      >
        Find · scope: {scope}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        {showClearScope && (
          <button
            type="button"
            onClick={onClearScope}
            title="Clear scope (show all cities)"
            style={{
              fontSize: '0.7rem',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              background: 'transparent',
              border: '1px solid var(--border-muted, #D8D2C8)',
              color: 'var(--text-muted, #7A7368)',
              padding: '0.25rem 0.55rem',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            ⊕ Global
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          title="Reload /global-fibers"
          style={{
            fontSize: '0.7rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            background: 'transparent',
            border: '1px solid var(--border-muted, #D8D2C8)',
            color: 'var(--text-muted, #7A7368)',
            padding: '0.25rem 0.55rem',
            borderRadius: '3px',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * SearchBar — controlled search input. Wiring is Stage K only (state lift +
 * `/` focus event). Stage C+E plugs the actual `fzy`-ranked results and the
 * "trees flatten when query is non-empty" behaviour on top of `query`.
 *
 * The classname `FIND_SEARCH_INPUT_CLASS` is the contract main.ts uses to
 * implement the `// chord`: when `/` arrives and the active element is this
 * input, main.ts inspects `value.length` to decide between "type literally"
 * and "escalate scope."
 * ------------------------------------------------------------------------ */

function SearchBar({
  inputRef,
  value,
  onChange,
}: {
  inputRef: React.RefObject<HTMLInputElement>
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.55rem',
        padding: '0.55rem 0.85rem',
        border: '1px solid var(--border-muted, #D8D2C8)',
        borderRadius: '4px',
        background: 'var(--surface-raised, #FFFDF8)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: '0.95rem',
          opacity: 0.5,
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        }}
      >
        ⌕
      </span>
      <input
        ref={inputRef}
        className={FIND_SEARCH_INPUT_CLASS}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search fibers + files…  (Stage C+E will wire ranking)"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'inherit',
          font: 'inherit',
          fontSize: '0.95rem',
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          title="Clear"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted, #7A7368)',
            fontSize: '0.85rem',
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * FibersSection — the cross-project fibers tree (Stage B). One collapsible
 * panel per city group; inside, top-level fibers + one expand level. Beyond
 * that, click-through to vellum's per-fiber navigation per the constitution
 * decision "Vellum's navigation chrome carries the up/down browse."
 * ------------------------------------------------------------------------ */

interface FibersSectionProps {
  loading: boolean
  error: string | null
  data: GlobalFibersResponse | null
  cityById: Map<
    string,
    { name?: string; path: string; originId: string; gitStatus?: CityGitStatus }
  >
  focusedCityId?: string
  openCityKeys: Set<string>
  setOpenCityKeys: (updater: (prev: Set<string>) => Set<string>) => void
  openFiberKeys: Set<string>
  setOpenFiberKeys: (updater: (prev: Set<string>) => Set<string>) => void
  onOpenFiberInCity?: (cityId: string, slug: string) => void
}

function FibersSection(props: FibersSectionProps): JSX.Element {
  const { loading, error, data } = props
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SectionHeader title="Fibers" />
      {loading && <Status>Loading…</Status>}
      {!loading && error && <Status tone="error">Failed: {error}</Status>}
      {!loading && !error && data && data.cities.length === 0 && (
        <Status>No connected cities.</Status>
      )}
      {!loading && !error && data && data.cities.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {data.cities.map((group) => (
            <CityGroup
              key={groupKeyOf(group)}
              group={group}
              {...props}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SectionHeader({ title }: { title: string }): JSX.Element {
  return (
    <h2
      style={{
        fontSize: '0.7rem',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        margin: 0,
        opacity: 0.55,
        borderBottom: '1px solid var(--border-muted, #E5DFD5)',
        paddingBottom: '0.4rem',
      }}
    >
      {title}
    </h2>
  )
}

function Status({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: 'error'
}): JSX.Element {
  return (
    <div
      style={{
        fontSize: '0.85rem',
        opacity: 0.7,
        padding: '0.5rem 0.25rem',
        color: tone === 'error' ? 'var(--text-error, #B5402F)' : 'inherit',
      }}
    >
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * CityGroup — collapsible per-city panel. Header shows the city name +
 * fiber count + remote/stale badges; body renders the 2-level fiber tree.
 * ------------------------------------------------------------------------ */

function CityGroup({
  group,
  cityById,
  focusedCityId,
  openCityKeys,
  setOpenCityKeys,
  openFiberKeys,
  setOpenFiberKeys,
  onOpenFiberInCity,
}: { group: GlobalFiberCityGroup } & FibersSectionProps): JSX.Element {
  const key = groupKeyOf(group)
  const isOpen = openCityKeys.has(key)
  const isFocused = !!group.cityId && group.cityId === focusedCityId
  const cityMeta = group.cityId ? cityById.get(group.cityId) : undefined
  const displayName = group.cityId
    ? (cityMeta?.name
        ?? cityMeta?.path?.split('/').pop()
        ?? group.cityId.slice(0, 8))
    : group.hostname
      ? `remote: ${group.hostname}`
      : 'unscoped'
  const fiberCount = group.fibers.length

  // Build the parent → children index once per render. Cheap relative to
  // tree mounts; avoids passing the whole array down repeatedly.
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, GlobalFiberNode[]>()
    const presentIds = new Set(group.fibers.map((f) => f.id))
    for (const fiber of group.fibers) {
      // If a fiber's `parentId` isn't in this group (e.g. parent is in a
      // sibling project, or hasn't been crawled), bubble it up to the
      // top level rather than dropping it. Mirrors the orphan-handling
      // the pre-Stage-I HUD did for closed parents.
      const rawParent = fiber.parentId
      const parent = rawParent && presentIds.has(rawParent) ? rawParent : null
      if (!map.has(parent)) map.set(parent, [])
      map.get(parent)!.push(fiber)
    }
    // Stable sort: status (active → open → unset → closed), then name.
    for (const list of map.values()) {
      list.sort((a, b) => {
        const r = statusRank(a.status) - statusRank(b.status)
        if (r !== 0) return r
        return a.name.localeCompare(b.name)
      })
    }
    return map
  }, [group.fibers])

  const topLevel = childrenByParent.get(null) ?? []

  const toggleOpen = (): void => {
    setOpenCityKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleFiberClick = (fiber: GlobalFiberNode): void => {
    if (group.originId !== 'local' || !group.cityId) {
      // Remote-origin click-through is deferred per Scope §"Out". Surface
      // a console warning so the gap is observable rather than silent.
      console.warn(
        `[FindHost] remote-origin fiber click is not yet wired ` +
          `(originId=${group.originId}, id=${fiber.id}). Follow-up work ` +
          `in the navigation-layer constitution.`,
      )
      return
    }
    if (!onOpenFiberInCity) {
      console.warn('[FindHost] onOpenFiberInCity not wired; click ignored.')
      return
    }
    onOpenFiberInCity(group.cityId, fiber.id)
  }

  const toggleFiber = (fiber: GlobalFiberNode): void => {
    const fiberKey = `${key}::${fiber.id}`
    setOpenFiberKeys((prev) => {
      const next = new Set(prev)
      if (next.has(fiberKey)) next.delete(fiberKey)
      else next.add(fiberKey)
      return next
    })
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-muted, #E5DFD5)',
        borderRadius: '4px',
        background: isFocused
          ? 'var(--surface-raised, #FFFDF8)'
          : 'transparent',
        opacity: group.isStale ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={isOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.55rem',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '0.55rem 0.75rem',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: '0.75rem',
            opacity: 0.6,
            fontSize: '0.7rem',
          }}
          aria-hidden="true"
        >
          {isOpen ? '▾' : '▸'}
        </span>
        <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{displayName}</span>
        {isFocused && (
          <span
            style={{
              fontSize: '0.6rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              opacity: 0.6,
            }}
          >
            focused
          </span>
        )}
        {group.isStale && (
          <span
            style={{
              fontSize: '0.65rem',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-warning, #B58200)',
            }}
            title={group.staleSince ? `Stale since ${group.staleSince}` : 'Snapshot is stale'}
          >
            stale
          </span>
        )}
        {group.originId !== 'local' && (
          <span
            style={{
              fontSize: '0.6rem',
              letterSpacing: '0.05em',
              opacity: 0.55,
              fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            }}
          >
            {group.originId}
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '0.7rem',
            opacity: 0.5,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {fiberCount}
        </span>
      </button>
      {isOpen && (
        <div
          style={{
            borderTop: '1px solid var(--border-muted, #EFEAE0)',
            padding: '0.25rem 0.25rem 0.4rem',
          }}
        >
          {topLevel.length === 0 ? (
            <div
              style={{
                padding: '0.5rem 0.75rem',
                fontSize: '0.8rem',
                opacity: 0.5,
              }}
            >
              No fibers.
            </div>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
              }}
            >
              {topLevel.map((fiber) => (
                <FiberRow
                  key={fiber.id}
                  fiber={fiber}
                  groupKey={key}
                  childrenByParent={childrenByParent}
                  openFiberKeys={openFiberKeys}
                  onToggle={toggleFiber}
                  onOpen={handleFiberClick}
                  depth={0}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * FiberRow — one tree row. Renders the row itself, plus (if depth=0 and
 * expanded) one nested level of children. Per the constitution, depth
 * stops here: deeper navigation lives in vellum after the click.
 * ------------------------------------------------------------------------ */

function FiberRow({
  fiber,
  groupKey,
  childrenByParent,
  openFiberKeys,
  onToggle,
  onOpen,
  depth,
}: {
  fiber: GlobalFiberNode
  groupKey: string
  childrenByParent: Map<string | null, GlobalFiberNode[]>
  openFiberKeys: Set<string>
  onToggle: (fiber: GlobalFiberNode) => void
  onOpen: (fiber: GlobalFiberNode) => void
  depth: number
}): JSX.Element {
  const fiberKey = `${groupKey}::${fiber.id}`
  const isOpen = openFiberKeys.has(fiberKey)
  // hasChildren comes from the wire shape (server walks parentId in pass 2).
  // We could re-derive from childrenByParent.get(fiber.id), but trusting the
  // server keeps the row cheap and lets us render before the children index
  // is touched. Both should agree; if they ever diverge, the tree's still
  // navigable via click-through.
  const hasChildren = fiber.hasChildren && depth === 0
  const kindBadge = fiber.kind && fiber.kind !== 'task' ? fiber.kind : null
  const lede = fiber.outcome?.trim()

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.4rem',
          padding: '0.25rem 0.4rem',
          paddingLeft: `${0.4 + depth * 1.2}rem`,
          borderRadius: '3px',
        }}
        className="find-fiber-row"
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(fiber)}
            aria-expanded={isOpen}
            title={isOpen ? 'Collapse' : 'Expand'}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.65rem',
              opacity: 0.6,
              width: '0.9rem',
              padding: 0,
              color: 'inherit',
            }}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span
            aria-hidden="true"
            style={{ display: 'inline-block', width: '0.9rem' }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            opacity: 0.7,
            fontSize: '0.75rem',
            width: '0.9rem',
            textAlign: 'center',
          }}
        >
          {fiberStatusIcon(fiber.status || 'open')}
        </span>
        <button
          type="button"
          onClick={() => onOpen(fiber)}
          title={fiber.id}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
            padding: 0,
            textAlign: 'left',
            fontSize: '0.85rem',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {fiber.name || fiber.id}
        </button>
        {kindBadge && (
          <span
            style={{
              fontSize: '0.6rem',
              letterSpacing: '0.05em',
              opacity: 0.55,
              border: '1px solid var(--border-muted, #E5DFD5)',
              padding: '0 0.3rem',
              borderRadius: '2px',
              flexShrink: 0,
            }}
          >
            {kindBadge}
          </span>
        )}
      </div>
      {lede && (
        <div
          style={{
            fontSize: '0.72rem',
            opacity: 0.55,
            paddingLeft: `${0.4 + depth * 1.2 + 2.2}rem`,
            paddingRight: '0.4rem',
            paddingBottom: '0.15rem',
            lineHeight: 1.4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lede}
        </div>
      )}
      {hasChildren && isOpen && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(childrenByParent.get(fiber.id) ?? []).map((child) => (
            <FiberRow
              key={child.id}
              fiber={child}
              groupKey={groupKey}
              childrenByParent={childrenByParent}
              openFiberKeys={openFiberKeys}
              onToggle={onToggle}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ *
 * RecentsSection — Stage G of constitution-portolan-navigation-layer.
 *
 * Top-N rolled-up view log fed by the SQLite-backed RecentsStore. One row
 * per (origin, city, kind, path), sorted by latest view across viewers.
 * Kind badges: ⬡ for fibers, 📄 for files. Viewer badges: [h] when a
 * human's viewed it, [a] when an agent has — both when both. Click a
 * row to open it in vellum (pivots scope across cities as needed).
 *
 * Scope follows the in-Find scope (`focusedCityId`). Polls every 5s
 * and re-fetches whenever the scope flips so a brand-new view from the
 * agent or another window shows up without a manual refresh.
 *
 * Disconnected origins are tagged "stale" via the same-origin-id check
 * the constitution requires; here that's the empty-list path (server
 * returns enabled:false → empty entries → "no recents yet"). Once a
 * remote-origin recents wire grows, the stale tag will move out of the
 * empty-state fallback into per-row annotation.
 * ------------------------------------------------------------------------ */

interface RecentEntry {
  originId: string
  cityId: string
  kind: 'fiber' | 'file'
  path: string
  lastViewedAt: number
  viewCount: number
  viewerKinds: Array<'human' | 'agent'>
}

interface RecentsCity {
  id: string
  name?: string
  path: string
  originId: string
}

function RecentsSection({
  focusedCityId,
  cities,
  refreshTick,
  onOpenFiberInCity,
}: {
  focusedCityId?: string
  cities: RecentsCity[]
  /** Bumped by the eyebrow Refresh button + by recordRecentTouch callers
   *  so a fresh open shows up immediately rather than waiting for the
   *  poll. Threaded through from FindHost. */
  refreshTick: number
  onOpenFiberInCity?: (cityId: string, slug: string) => void
}): JSX.Element {
  const [entries, setEntries] = useState<RecentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Re-fetch on scope or refresh, then poll every 5s. The poll catches
  // agent file-touches arriving from EventWatcher and human opens fired
  // from a different window without forcing the user to hit refresh.
  useEffect(() => {
    let cancelled = false
    const fetchRecents = async (): Promise<void> => {
      try {
        const params = new URLSearchParams()
        if (focusedCityId) params.set('cityId', focusedCityId)
        params.set('limit', '12')
        const res = await fetch(`${API_BASE}/recents?${params}`)
        if (!res.ok) throw new Error(`recents ${res.status}`)
        const body = await res.json() as { entries?: RecentEntry[] }
        if (cancelled) return
        setEntries(body.entries ?? [])
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'unknown')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchRecents()
    const id = window.setInterval(fetchRecents, 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [focusedCityId, refreshTick])

  const cityById = useMemo(() => new Map(cities.map(c => [c.id, c])), [cities])

  const handleClick = (entry: RecentEntry): void => {
    if (entry.kind === 'fiber') {
      if (!onOpenFiberInCity) {
        console.warn('[RecentsSection] onOpenFiberInCity not wired; click ignored.')
        return
      }
      onOpenFiberInCity(entry.cityId, entry.path)
      return
    }
    // File click: route through the mountContext.openFile() callback
    // (installed by main.ts). Reconstitute the absolute path from city
    // root + relative path so vellum's file mode receives a real fs
    // path (matches the FilesColumn click contract).
    const ctx = getPortolanMountContext()
    if (!ctx?.openFile) {
      console.warn('[RecentsSection] openFile not wired; click ignored.')
      return
    }
    const city = cityById.get(entry.cityId)
    if (!city) {
      console.warn('[RecentsSection] city not found for entry; click ignored.', entry)
      return
    }
    const cityRoot = city.path.endsWith('/') ? city.path : `${city.path}/`
    const absolutePath = entry.path.startsWith('/') ? entry.path : cityRoot + entry.path
    ctx.openFile({ path: absolutePath, cityId: entry.cityId, originId: entry.originId })
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SectionHeader title="Recents" />
      {loading && entries.length === 0 ? (
        <Status>Loading…</Status>
      ) : error ? (
        <Status tone="error">recents: {error}</Status>
      ) : entries.length === 0 ? (
        <Status>No recents yet.</Status>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.15rem',
          }}
        >
          {entries.map((entry) => (
            <RecentsRow
              key={`${entry.originId}::${entry.cityId}::${entry.kind}::${entry.path}`}
              entry={entry}
              cityName={cityById.get(entry.cityId)?.name ?? entry.cityId}
              onClick={() => handleClick(entry)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function RecentsRow({
  entry,
  cityName,
  onClick,
}: {
  entry: RecentEntry
  cityName: string
  onClick: () => void
}): JSX.Element {
  const kindGlyph = entry.kind === 'fiber' ? '⬡' : '📄'
  const lastViewedLabel = formatDistanceToNow(entry.lastViewedAt, { addSuffix: true })
  const showHuman = entry.viewerKinds.includes('human')
  const showAgent = entry.viewerKinds.includes('agent')
  // Display path: for fibers, the full slug; for files, the basename
  // with the parent dir for context (matches the activity-row pattern
  // RecentWorkerBar uses on the map). Full path goes in the title attr
  // so hover discloses the rest.
  const display = entry.kind === 'fiber'
    ? entry.path
    : displayFilePath(entry.path)
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={`${entry.path} — ${entry.viewCount}× — ${lastViewedLabel}`}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: '0.3rem 0.4rem',
          borderRadius: '3px',
          cursor: 'pointer',
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
          alignItems: 'baseline',
          gap: '0.5rem',
          color: 'inherit',
          fontSize: '0.82rem',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-hover, #F1ECE3)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
      >
        <span aria-hidden style={{ fontSize: '0.75rem', opacity: 0.7 }}>
          {kindGlyph}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {display}
        </span>
        <span
          style={{
            fontSize: '0.65rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            opacity: 0.55,
            border: '1px solid var(--border-muted, #D8D2C8)',
            padding: '0.05rem 0.35rem',
            borderRadius: '2px',
          }}
        >
          {cityName}
        </span>
        <span style={{ display: 'flex', gap: '0.2rem' }}>
          {showHuman && (
            <span
              aria-label="human view"
              title="Human view"
              style={{
                fontSize: '0.6rem',
                opacity: 0.7,
                border: '1px solid var(--border-muted, #D8D2C8)',
                padding: '0.05rem 0.3rem',
                borderRadius: '2px',
              }}
            >
              h
            </span>
          )}
          {showAgent && (
            <span
              aria-label="agent view"
              title="Agent view"
              style={{
                fontSize: '0.6rem',
                opacity: 0.7,
                border: '1px solid var(--border-muted, #D8D2C8)',
                padding: '0.05rem 0.3rem',
                borderRadius: '2px',
              }}
            >
              a
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

function displayFilePath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return path
  const filename = parts.pop() ?? ''
  const parent = parts.pop() ?? ''
  if (!parent) return filename
  return `${parent}/${filename}`
}

/* ------------------------------------------------------------------------ *
 * GitSection — per-city git status (Stage F). The pre-Stage-I CityHUD
 * carried a single-city git block in its header; this section lifts that
 * shape to a stack, one row per local city, with the focused city pinned
 * to the top. Global scope shows the full stack (the constitution's
 * "noisy is acceptable — the user wanted it in"); city scope auto-
 * collapses non-focused cities behind their headers.
 *
 * Remote cities don't carry gitStatus across the snapshot wire today, so
 * they're excluded from the section. If/when remote-snapshot wiring grows
 * a git axis, drop the originId filter in `gitCities` and these rows will
 * show up automatically.
 * ------------------------------------------------------------------------ */

function GitSection({
  cities,
  focusedCityId,
}: {
  cities: GitSectionCity[]
  focusedCityId?: string
}): JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SectionHeader title="Git" />
      {cities.length === 0 ? (
        <Status>No connected local cities.</Status>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {cities.map((c) => (
            <GitCityRow
              key={c.cityId}
              city={c}
              isFocused={!!focusedCityId && c.cityId === focusedCityId}
              defaultOpen={!focusedCityId || c.cityId === focusedCityId}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Per-city git block. Header line is always visible (branch + diff inline);
 * details (staged/unstaged/untracked + lines + last commit) live inside a
 * collapsible body so the section stays scannable across many cities.
 *
 * Visual choice: inline-style React idiom matching the rest of FindHost.
 * (The pre-Stage-I CityHUD git block used `.hud-gd-*` classes in
 * index.html; that styling retired with the HUD.)
 */
function GitCityRow({
  city,
  isFocused,
  defaultOpen,
}: {
  city: GitSectionCity
  isFocused: boolean
  defaultOpen: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const status = city.gitStatus
  const isRepo = !!status?.isRepo

  return (
    <div
      style={{
        border: '1px solid var(--border-muted, #E5DFD5)',
        borderRadius: '4px',
        background: isFocused ? 'var(--surface-raised, #FFFDF8)' : 'transparent',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.55rem',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '0.55rem 0.75rem',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: '0.75rem',
            opacity: 0.6,
            fontSize: '0.7rem',
          }}
          aria-hidden="true"
        >
          {open ? '▾' : '▸'}
        </span>
        <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{city.displayName}</span>
        {isFocused && (
          <span
            style={{
              fontSize: '0.6rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              opacity: 0.6,
            }}
          >
            focused
          </span>
        )}
        {isRepo ? (
          <GitHeaderInline status={status!} />
        ) : (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.7rem',
              opacity: 0.45,
              fontStyle: 'italic',
            }}
          >
            no git
          </span>
        )}
      </button>
      {open && isRepo && (
        <div
          style={{
            borderTop: '1px solid var(--border-muted, #EFEAE0)',
            padding: '0.5rem 0.85rem 0.6rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.2rem',
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: '0.78rem',
          }}
        >
          <GitDetailRows status={status!} />
        </div>
      )}
    </div>
  )
}

/**
 * One-line summary that rides the row header so the section is still useful
 * when the body is collapsed: "↑3 ↓1 +42 −7". Empty when the working tree is
 * clean and the branch is in sync. Lives in the right-aligned slot the row's
 * fiber-count occupies in the Fibers section; mirrors that visual rhythm.
 */
function GitHeaderInline({ status }: { status: CityGitStatus }): JSX.Element {
  const parts: JSX.Element[] = []
  if (status.ahead > 0) {
    parts.push(
      <span key="ahead" style={{ color: 'var(--text-success, #5a8a5a)' }}>
        ↑{status.ahead}
      </span>,
    )
  }
  if (status.behind > 0) {
    parts.push(
      <span key="behind" style={{ color: 'var(--text-error, #B5402F)' }}>
        ↓{status.behind}
      </span>,
    )
  }
  if (status.linesAdded > 0) {
    parts.push(
      <span key="la" style={{ color: 'var(--text-success, #5a8a5a)' }}>
        +{status.linesAdded}
      </span>,
    )
  }
  if (status.linesRemoved > 0) {
    parts.push(
      <span key="lr" style={{ color: 'var(--text-error, #B5402F)' }}>
        −{status.linesRemoved}
      </span>,
    )
  }
  return (
    <span
      style={{
        marginLeft: 'auto',
        display: 'flex',
        gap: '0.45rem',
        fontSize: '0.72rem',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.85,
      }}
    >
      <span style={{ color: 'var(--text-muted, #7A7368)' }}>{status.branch}</span>
      {parts}
    </span>
  )
}

/**
 * Detail rows shown when a row is expanded. Mirrors the HUD's order:
 * branch, remote, staged, unstaged, untracked, diff, last commit. Each
 * row is `label → value` with monospace right-aligned values so digits
 * line up across rows.
 */
function GitDetailRows({ status }: { status: CityGitStatus }): JSX.Element {
  const rows: JSX.Element[] = []

  rows.push(
    <DetailRow
      key="branch"
      label="branch"
      value={
        <span style={{ color: 'var(--accent, #8A5A2B)', fontWeight: 500 }}>
          {status.branch}
        </span>
      }
    />,
  )

  if (status.ahead > 0 || status.behind > 0) {
    rows.push(
      <DetailRow
        key="remote"
        label="remote"
        value={
          <>
            {status.ahead > 0 && (
              <span style={{ color: 'var(--text-success, #5a8a5a)' }}>
                ↑{status.ahead}
              </span>
            )}
            {status.ahead > 0 && status.behind > 0 && ' '}
            {status.behind > 0 && (
              <span style={{ color: 'var(--text-error, #B5402F)' }}>
                ↓{status.behind}
              </span>
            )}
          </>
        }
      />,
    )
  }

  const stagedTotal =
    status.staged.added + status.staged.modified + status.staged.deleted
  if (stagedTotal > 0) {
    rows.push(
      <DetailRow
        key="staged"
        label="staged"
        value={<GitFileCounts counts={status.staged} accent="success" />}
      />,
    )
  }

  const unstagedTotal =
    status.unstaged.added + status.unstaged.modified + status.unstaged.deleted
  if (unstagedTotal > 0) {
    rows.push(
      <DetailRow
        key="unstaged"
        label="unstaged"
        value={<GitFileCounts counts={status.unstaged} accent="muted" />}
      />,
    )
  }

  if (status.untracked > 0) {
    rows.push(
      <DetailRow
        key="untracked"
        label="untracked"
        value={
          <span style={{ color: 'var(--text-muted, #7A7368)' }}>
            {status.untracked} file{status.untracked !== 1 ? 's' : ''}
          </span>
        }
      />,
    )
  }

  if (status.linesAdded > 0 || status.linesRemoved > 0) {
    rows.push(
      <DetailRow
        key="diff"
        label="diff"
        value={
          <>
            {status.linesAdded > 0 && (
              <span style={{ color: 'var(--text-success, #5a8a5a)' }}>
                +{status.linesAdded}
              </span>
            )}
            {status.linesAdded > 0 && status.linesRemoved > 0 && ' '}
            {status.linesRemoved > 0 && (
              <span style={{ color: 'var(--text-error, #B5402F)' }}>
                −{status.linesRemoved}
              </span>
            )}
          </>
        }
      />,
    )
  }

  if (status.lastCommitMessage) {
    const msg =
      status.lastCommitMessage.length > 64
        ? status.lastCommitMessage.slice(0, 64) + '…'
        : status.lastCommitMessage
    const time = status.lastCommitTime
      ? formatDistanceToNow(status.lastCommitTime, { addSuffix: true })
      : null
    rows.push(
      <div
        key="commit"
        style={{
          marginTop: '0.35rem',
          paddingTop: '0.35rem',
          borderTop: '1px solid var(--border-muted, #EFEAE0)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.1rem',
        }}
      >
        <span
          style={{
            color: 'var(--text, #2A2118)',
            fontStyle: 'italic',
            fontFamily: 'var(--font-main, inherit)',
          }}
        >
          {msg}
        </span>
        {time && (
          <span style={{ color: 'var(--text-muted, #7A7368)', fontSize: '0.7rem' }}>
            {time}
          </span>
        )}
      </div>,
    )
  }

  return <>{rows}</>
}

function DetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '0.75rem',
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: 'var(--text-muted, #7A7368)', minWidth: '4rem' }}>
        {label}
      </span>
      <span
        style={{
          textAlign: 'right',
          color: 'var(--text, #2A2118)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function GitFileCounts({
  counts,
  accent,
}: {
  counts: { added: number; modified: number; deleted: number }
  accent: 'success' | 'muted'
}): JSX.Element {
  const color =
    accent === 'success'
      ? 'var(--text-success, #5a8a5a)'
      : 'var(--text-muted, #7A7368)'
  const parts: string[] = []
  if (counts.added > 0) parts.push(`+${counts.added}`)
  if (counts.modified > 0) parts.push(`~${counts.modified}`)
  if (counts.deleted > 0) parts.push(`-${counts.deleted}`)
  return <span style={{ color }}>{parts.join(' ')}</span>
}

/* ------------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------------ */

function groupKeyOf(group: GlobalFiberCityGroup): string {
  if (group.originId === 'local') return `local::${group.cityId ?? '?'}`
  return group.originId
}

function statusRank(status: string): number {
  switch (status) {
    case 'active':
      return 0
    case 'open':
      return 1
    case '':
      return 2
    case 'closed':
      return 3
    default:
      return 4
  }
}

/* ------------------------------------------------------------------------ *
 * CitiesColumn — Stage D's left column. Pinned local cities, with their
 * workers nested underneath. Click city → re-scope Find in place (the
 * map camera stays put per the constitution); click worker → kitty
 * focus via the host's `onOpenWorker` plumb. Filters in step with the
 * search input: when the query is non-empty, fzy-rank both city names
 * and nested worker names, drop rows that match neither, and order by
 * the best score across the row's contents.
 *
 * "All cities" pseudo-row at the top resets scope to global. Doubles
 * with the eyebrow's `⊕ Global` affordance — both surfaces accept the
 * de-scope action so the user can climb back without remembering which
 * one carries it.
 *
 * Activity ranking: cities sort by max(session.lastActivity) of their
 * workers descending, with the scoped city pinned to the top. Cities
 * without active workers fall to alphabetical at the bottom.
 *
 * Remote cities are listed when known but render with a muted "remote"
 * badge; the constitution scopes Find primarily to local cities (the
 * Files column already does so), but the Cities column's job is
 * navigational discovery — surfacing remote cities here is cheap and
 * keeps cross-host parity legible.
 * ------------------------------------------------------------------------ */

interface CityWithWorkers {
  city: { id: string; name?: string; path: string; originId: string }
  workers: Array<{ id: string; name: string; tmuxSession: string; status: 'idle' | 'working'; lastActivity: number }>
  /** Highest of `lastActivity` across the city's workers; 0 if none.
   *  Used for activity-descending sort when query is empty. */
  lastActivity: number
  /** fzy match score when query is non-empty; max over (city name,
   *  worker names). Cities/workers below SCORE_MIN are dropped. */
  matchScore: number
  /** Workers that survive the query filter when query is non-empty.
   *  When query is empty, all workers pass through. */
  matchedWorkers: Array<{ id: string; name: string; tmuxSession: string; status: 'idle' | 'working'; lastActivity: number }>
}

function CitiesColumn({
  cities,
  scopedCityId,
  onScopeCity,
  onOpenWorker,
  query,
}: {
  cities: Array<{ id: string; name?: string; path: string; originId: string }>
  scopedCityId: string | undefined
  /** Setter from FindHost; passing undefined re-scopes to global. */
  onScopeCity: (next: string | undefined) => void
  onOpenWorker?: (tmuxSessionName: string) => void
  /** Debounced query — same source as the Fibers/Files combined-results
   *  filter, so all three columns narrow in step. Empty string disables
   *  filtering and shows every city. */
  query: string
}): JSX.Element {
  // Read sessions live via the mount context. Stage E established the
  // tick-based refresh pattern (FindHost re-runs portolanCities every
  // stateTick), but worker rosters change less often than city pins;
  // re-reading on every render is cheap (sessions array < 50 entries).
  const ctx = getPortolanMountContext()
  const sessions = ctx ? ctx.getSessions() : []

  const trimmed = query.trim()
  const isFiltering = trimmed.length > 0

  const rows = useMemo<CityWithWorkers[]>(() => {
    const sessionsByCity = new Map<string, typeof sessions>()
    for (const s of sessions) {
      if (!s.cityId) continue
      const list = sessionsByCity.get(s.cityId) ?? []
      list.push(s)
      sessionsByCity.set(s.cityId, list)
    }
    // Sort each city's workers by lastActivity descending (most recent
    // first) so a quick glance at a city shows the active set up top.
    for (const list of sessionsByCity.values()) {
      list.sort((a, b) => b.lastActivity - a.lastActivity)
    }

    const all: CityWithWorkers[] = cities.map((city) => {
      const list = sessionsByCity.get(city.id) ?? []
      const workers = list.map((s) => ({
        id: s.id,
        name: s.name,
        tmuxSession: s.tmuxSession,
        status: s.status,
        lastActivity: s.lastActivity,
      }))
      const lastActivity = workers.reduce((max, w) => Math.max(max, w.lastActivity), 0)

      // Filter logic when querying. fzy.hasMatch is cheap (single pass
      // over haystack), so we run it city-then-each-worker and keep the
      // max score across the row. A worker match keeps its city in the
      // results even if the city's own name didn't match (the constitution
      // wants "filters in step with the search" — surfacing a city
      // because of one of its workers is the navigationally-useful read).
      let matchScore = -Infinity
      let matchedWorkers = workers
      if (isFiltering) {
        const cityHaystack = city.name ?? city.path.split('/').pop() ?? city.id
        if (fzyHasMatch(trimmed, cityHaystack)) {
          matchScore = Math.max(matchScore, fzyScore(trimmed, cityHaystack))
        }
        const survivingWorkers: typeof workers = []
        for (const w of workers) {
          if (fzyHasMatch(trimmed, w.name)) {
            const s = fzyScore(trimmed, w.name)
            matchScore = Math.max(matchScore, s)
            survivingWorkers.push(w)
          }
        }
        // If the city's own name matched but no individual worker name
        // did, keep all workers (city-level match is a row-level keep).
        // If the city's name didn't match, only the surviving workers
        // belong on this row.
        const cityMatched = matchScore > -Infinity && fzyHasMatch(trimmed, cityHaystack)
        matchedWorkers = cityMatched ? workers : survivingWorkers
      }

      return { city, workers, lastActivity, matchScore, matchedWorkers }
    })

    if (isFiltering) {
      return all
        .filter((r) => r.matchScore > -Infinity)
        .sort((a, b) => {
          // Pin scoped city to the top regardless of score so the user
          // can always see their current scope while filtering.
          if (a.city.id === scopedCityId && b.city.id !== scopedCityId) return -1
          if (b.city.id === scopedCityId && a.city.id !== scopedCityId) return 1
          return b.matchScore - a.matchScore
        })
    }

    return all.sort((a, b) => {
      if (a.city.id === scopedCityId && b.city.id !== scopedCityId) return -1
      if (b.city.id === scopedCityId && a.city.id !== scopedCityId) return 1
      // Activity descending; cities with no activity fall to the bottom
      // sorted alphabetically by display name.
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity
      const an = a.city.name ?? a.city.path.split('/').pop() ?? a.city.id
      const bn = b.city.name ?? b.city.path.split('/').pop() ?? b.city.id
      return an.localeCompare(bn)
    })
  }, [cities, sessions, scopedCityId, trimmed, isFiltering])

  const handleWorkerClick = (worker: { tmuxSession: string }): void => {
    if (!onOpenWorker) {
      console.warn('[FindHost/Cities] onOpenWorker not wired; click ignored.')
      return
    }
    onOpenWorker(worker.tmuxSession)
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SectionHeader title="Cities" />
      {rows.length === 0 ? (
        <Status>{isFiltering ? 'No matches.' : 'No connected cities.'}</Status>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.05rem',
          }}
        >
          {/* All cities pseudo-row — visible whenever scope can be cleared.
              Counterpart to the eyebrow's ⊕ Global affordance. Suppressed
              while filtering: the scope-clear action is itself global,
              and showing it inside a filtered list reads as a stray
              non-match. */}
          {!isFiltering && (
            <li>
              <CityRow
                label="All cities"
                glyph="⊕"
                isScoped={scopedCityId === undefined}
                onClick={() => onScopeCity(undefined)}
                isRemote={false}
                isAllRow
              />
            </li>
          )}
          {rows.map(({ city, matchedWorkers }) => {
            const displayName = city.name ?? city.path.split('/').pop() ?? city.id
            const isScoped = city.id === scopedCityId
            const isRemote = city.originId !== 'local'
            return (
              <li key={city.id}>
                <CityRow
                  label={displayName}
                  glyph="⬢"
                  isScoped={isScoped}
                  onClick={() =>
                    // Toggle: clicking the currently-scoped city de-scopes.
                    // Mirrors how the eyebrow's ⊕ Global button works; lets
                    // the user navigate without crossing back to the eyebrow.
                    onScopeCity(isScoped ? undefined : city.id)
                  }
                  isRemote={isRemote}
                />
                {matchedWorkers.length > 0 && (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    {matchedWorkers.map((worker) => (
                      <li key={worker.id}>
                        <WorkerRow
                          name={worker.name}
                          status={worker.status}
                          onClick={() => handleWorkerClick(worker)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function CityRow({
  label,
  glyph,
  isScoped,
  onClick,
  isRemote,
  isAllRow,
}: {
  label: string
  glyph: string
  isScoped: boolean
  onClick: () => void
  isRemote: boolean
  isAllRow?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="find-fiber-row"
      title={isScoped ? `Scoped to ${label} — click to clear` : `Scope Find to ${label}`}
      aria-pressed={isScoped}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        width: '100%',
        background: isScoped ? 'var(--surface-raised, #FFFDF8)' : 'transparent',
        border: '1px solid',
        borderColor: isScoped ? 'var(--border-muted, #D8D2C8)' : 'transparent',
        borderRadius: '3px',
        padding: '0.35rem 0.5rem',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        // Italicize the All cities pseudo-row a touch so it reads as a
        // pseudo-row (an action) rather than a city the user could open.
        fontStyle: isAllRow ? 'italic' : 'normal',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: '0.95rem',
          opacity: 0.75,
          width: '1rem',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '0.85rem',
          fontWeight: isScoped ? 500 : 400,
        }}
      >
        {label}
      </span>
      {isScoped && !isAllRow && (
        <span
          style={{
            fontSize: '0.55rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            opacity: 0.6,
            flexShrink: 0,
          }}
        >
          scoped
        </span>
      )}
      {isRemote && (
        <span
          style={{
            fontSize: '0.6rem',
            letterSpacing: '0.05em',
            opacity: 0.5,
            border: '1px solid var(--border-muted, #E5DFD5)',
            padding: '0.05rem 0.3rem',
            borderRadius: '2px',
            flexShrink: 0,
          }}
        >
          remote
        </span>
      )}
    </button>
  )
}

function WorkerRow({
  name,
  status,
  onClick,
}: {
  name: string
  status: 'idle' | 'working'
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="find-fiber-row"
      title={`Focus kitty tab for ${name}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        width: '100%',
        // Indent under the city row. Matches the FibersSection nested
        // padding so the visual hierarchy reads consistent across columns.
        paddingLeft: '1.7rem',
        paddingRight: '0.5rem',
        paddingTop: '0.2rem',
        paddingBottom: '0.2rem',
        background: 'transparent',
        border: 'none',
        borderRadius: '3px',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: '0.85rem',
          opacity: status === 'working' ? 0.95 : 0.55,
          width: '1rem',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        🐦
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '0.78rem',
          opacity: status === 'working' ? 0.95 : 0.65,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {name}
      </span>
      {status === 'working' && (
        <span
          aria-label="working"
          title="Working"
          style={{
            display: 'inline-block',
            width: '0.45rem',
            height: '0.45rem',
            borderRadius: '50%',
            background: 'var(--text-success, #5a8a5a)',
            flexShrink: 0,
          }}
        />
      )}
    </button>
  )
}

/* ------------------------------------------------------------------------ *
 * FilesColumn — wraps `FindFilesSection` with the section header so the
 * empty-input layout reads parallel to Fibers (header above body). Lives
 * here rather than in FindFilesSection because the inline section header
 * convention is FindHost's vocabulary; the tree component itself stays
 * decoupled from the dashboard's typography.
 * ------------------------------------------------------------------------ */

function FilesColumn({
  cityId,
  cities,
}: {
  cityId?: string
  cities: Array<{ id: string; name?: string; path: string; originId: string }>
}): JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SectionHeader title="Files" />
      <FindFilesSection cityId={cityId} cities={cities} />
    </section>
  )
}

/* ------------------------------------------------------------------------ *
 * CombinedResultsSection — the single ranked list rendered when the search
 * input is non-empty. Spans the Fibers + Files grid columns so the layout
 * doesn't reflow when the user types/clears. Each row carries kind (fiber
 * | file | dir) and origin (city/host) badges so the user can see at a
 * glance where a hit comes from.
 *
 * Ranking: the server ranks each axis with fzy independently and returns
 * scored hits. We merge by interleaving on score, then render the union
 * top-N. The constitution doesn't ask for tie-breaking by kind, but
 * we sort by `score` descending and let the natural fzy weights resolve
 * (filename hits typically score higher than mid-body fiber hits, which
 * matches what the user expects).
 * ------------------------------------------------------------------------ */

interface CombinedFiberHit {
  kind: 'fiber'
  id: string
  name: string
  status: string
  fiberKind: string
  outcome?: string
  snippet?: string
  originId: string
  cityId?: string
  projectSlug?: string
  hostname?: string
  score: number
}

interface CombinedFileHit {
  kind: 'file' | 'dir'
  fullPath: string
  relativePath: string
  name: string
  cityId: string
  cityName?: string
  originId: string
  score: number
}

type CombinedHit = CombinedFiberHit | CombinedFileHit

function CombinedResultsSection({
  query,
  loading,
  error,
  fiberHits,
  fileHits,
  cityById,
  onOpenFiberInCity,
}: {
  query: string
  loading: boolean
  error: string | null
  fiberHits: CombinedFiberHit[]
  fileHits: CombinedFileHit[]
  cityById: Map<
    string,
    { name?: string; path: string; originId: string; gitStatus?: CityGitStatus }
  >
  onOpenFiberInCity?: (cityId: string, slug: string) => void
}): JSX.Element {
  const ctx = getPortolanMountContext()
  const openFile = ctx?.openFile

  const merged = useMemo<CombinedHit[]>(() => {
    const all: CombinedHit[] = [...fiberHits, ...fileHits]
    all.sort((a, b) => b.score - a.score)
    return all
  }, [fiberHits, fileHits])

  const handleClick = (hit: CombinedHit): void => {
    if (hit.kind === 'fiber') {
      if (hit.originId !== 'local' || !hit.cityId) {
        console.warn(
          '[FindHost] remote-origin fiber click is not yet wired ' +
            `(originId=${hit.originId}, id=${hit.id}).`,
        )
        return
      }
      onOpenFiberInCity?.(hit.cityId, hit.projectSlug ?? hit.id)
      return
    }
    if (hit.kind === 'file') {
      if (!openFile) {
        console.warn('[FindHost] openFile not wired; click ignored.')
        return
      }
      openFile({
        path: hit.fullPath,
        cityId: hit.cityId,
        originId: hit.originId,
      })
      return
    }
    // Directory click in combined results: no in-modal browse target,
    // since opening the directory in vellum's file mode would 404 on a
    // path-not-a-file. Surface in console so it's discoverable.
    console.info('[FindHost] directory results are browse-only:', hit.fullPath)
  }

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        // Span the Fibers + Files columns. The Cities column is the
        // first track of the grid; this section is grid-column 2/4 so
        // it occupies the middle and right tracks together.
        gridColumn: '2 / span 2',
      }}
    >
      <SectionHeader
        title={`Results · "${query}"${
          loading ? ' · loading…' : merged.length > 0 ? ` · ${merged.length}` : ''
        }`}
      />
      {error && <Status tone="error">{error}</Status>}
      {!loading && !error && merged.length === 0 && (
        <Status>No matches.</Status>
      )}
      {merged.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.15rem',
          }}
        >
          {merged.map((hit) => (
            <li key={keyForHit(hit)}>
              <CombinedRow
                hit={hit}
                cityName={resolveCityName(hit, cityById)}
                onClick={() => handleClick(hit)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CombinedRow({
  hit,
  cityName,
  onClick,
}: {
  hit: CombinedHit
  cityName?: string
  onClick: () => void
}): JSX.Element {
  const isFiber = hit.kind === 'fiber'
  const kindLabel = hit.kind
  const originLabel = isFiber
    ? hit.hostname ?? cityName ?? hit.cityId ?? hit.originId
    : cityName ?? hit.cityId
  const lede = isFiber ? hit.snippet ?? hit.outcome : hit.relativePath

  return (
    <button
      type="button"
      onClick={onClick}
      title={isFiber ? hit.id : hit.fullPath}
      className="find-fiber-row"
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        width: '100%',
        padding: '0.35rem 0.5rem',
        background: 'transparent',
        border: 'none',
        borderRadius: '3px',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          opacity: 0.7,
          fontSize: '0.75rem',
          width: '0.9rem',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {isFiber ? fiberStatusIcon(hit.status || 'open') : hit.kind === 'dir' ? '📁' : '📄'}
      </span>
      <span
        style={{
          fontSize: '0.85rem',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {hit.name}
        {lede && (
          <span
            style={{
              fontSize: '0.72rem',
              opacity: 0.55,
              marginLeft: '0.6rem',
            }}
          >
            {lede}
          </span>
        )}
      </span>
      <Badge>{kindLabel}</Badge>
      {originLabel && <Badge muted>{originLabel}</Badge>}
    </button>
  )
}

function Badge({
  children,
  muted,
}: {
  children: React.ReactNode
  muted?: boolean
}): JSX.Element {
  return (
    <span
      style={{
        fontSize: '0.6rem',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        opacity: muted ? 0.5 : 0.7,
        border: '1px solid var(--border-muted, #E5DFD5)',
        padding: '0.1rem 0.35rem',
        borderRadius: '2px',
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  )
}

function keyForHit(hit: CombinedHit): string {
  if (hit.kind === 'fiber') {
    return `fiber::${hit.originId}::${hit.id}`
  }
  return `${hit.kind}::${hit.cityId}::${hit.fullPath}`
}

function resolveCityName(
  hit: CombinedHit,
  cityById: Map<string, { name?: string; path: string }>,
): string | undefined {
  if (hit.kind === 'fiber') {
    if (!hit.cityId) return undefined
    const meta = cityById.get(hit.cityId)
    return meta?.name ?? meta?.path?.split('/').pop()
  }
  if (hit.cityName) return hit.cityName
  const meta = cityById.get(hit.cityId)
  return meta?.name ?? meta?.path?.split('/').pop()
}

/* ------------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------------ */

/** Trailing-edge debounce: returns `value` after `ms` of stability. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(handle)
  }, [value, ms])
  return debounced
}

/**
 * Drive the cross-axis search behind the combined results column. Two
 * parallel fetches per debounced query — `/global-search` (fibers) and
 * `/global-files-search` (files). Stale resolutions are dropped via a
 * cancellation token; an empty query immediately clears state so the
 * column drops back to trees without waiting for an in-flight request.
 */
function useCombinedSearch(query: string): {
  loading: boolean
  error: string | null
  fiberHits: CombinedFiberHit[]
  fileHits: CombinedFileHit[]
} {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    fiberHits: CombinedFiberHit[]
    fileHits: CombinedFileHit[]
  }>({
    loading: false,
    error: null,
    fiberHits: [],
    fileHits: [],
  })

  useEffect(() => {
    if (!query) {
      setState({ loading: false, error: null, fiberHits: [], fileHits: [] })
      return
    }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    const fibersUrl = `${API_BASE}/global-search?q=${encodeURIComponent(query)}&limit=20`
    const filesUrl = `${API_BASE}/global-files-search?q=${encodeURIComponent(query)}&limit=20`
    Promise.all([
      fetch(fibersUrl).then(async (res) => {
        if (!res.ok) throw new Error(`global-search ${res.status}`)
        return (await res.json()) as { hits?: unknown[] }
      }),
      fetch(filesUrl).then(async (res) => {
        if (!res.ok) throw new Error(`global-files-search ${res.status}`)
        return (await res.json()) as { hits?: unknown[] }
      }),
    ])
      .then(([fibers, files]) => {
        if (cancelled) return
        const fiberHits = (Array.isArray(fibers.hits) ? fibers.hits : []).map(
          (raw: unknown) => fiberHitOfWire(raw as Record<string, unknown>),
        )
        const fileHits = (Array.isArray(files.hits) ? files.hits : []).map(
          (raw: unknown) => fileHitOfWire(raw as Record<string, unknown>),
        )
        setState({ loading: false, error: null, fiberHits, fileHits })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = (err as { message?: string })?.message ?? String(err)
        console.error('[FindHost] combined search failed:', msg)
        setState({ loading: false, error: msg, fiberHits: [], fileHits: [] })
      })
    return () => {
      cancelled = true
    }
  }, [query])

  return state
}

function fiberHitOfWire(raw: Record<string, unknown>): CombinedFiberHit {
  return {
    kind: 'fiber',
    id: String(raw.id ?? ''),
    name: String(raw.name ?? raw.id ?? ''),
    status: String(raw.status ?? 'open'),
    fiberKind: String(raw.kind ?? 'task'),
    outcome: typeof raw.outcome === 'string' ? raw.outcome : undefined,
    snippet: typeof raw.snippet === 'string' ? raw.snippet : undefined,
    originId: String(raw.originId ?? 'local'),
    cityId: typeof raw.cityId === 'string' ? raw.cityId : undefined,
    projectSlug: typeof raw.projectSlug === 'string' ? raw.projectSlug : undefined,
    hostname: typeof raw.hostname === 'string' ? raw.hostname : undefined,
    score: typeof raw.score === 'number' ? raw.score : 0,
  }
}

function fileHitOfWire(raw: Record<string, unknown>): CombinedFileHit {
  const type = raw.type === 'dir' ? 'dir' : 'file'
  return {
    kind: type,
    fullPath: String(raw.fullPath ?? ''),
    relativePath: String(raw.relativePath ?? ''),
    name: String(raw.name ?? ''),
    cityId: String(raw.cityId ?? ''),
    cityName: typeof raw.cityName === 'string' ? raw.cityName : undefined,
    originId: String(raw.originId ?? 'local'),
    score: typeof raw.score === 'number' ? raw.score : 0,
  }
}

/**
 * Inject hover styling for `.find-fiber-row` once per page load. Inline-style
 * React doesn't carry `:hover` so we register a thin stylesheet at first
 * mount; idempotent via a sentinel id check.
 */
export function injectFindHostStyles(): void {
  if (typeof document === 'undefined') return
  const id = 'find-host-styles'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
    .find-fiber-row { transition: background 80ms linear; }
    .find-fiber-row:hover {
      background: var(--surface-hover, rgba(0, 0, 0, 0.04));
    }
    .${FIND_SEARCH_INPUT_CLASS}::placeholder {
      color: var(--text-muted, #7A7368);
      opacity: 0.55;
    }
  `
  document.head.appendChild(style)
}
