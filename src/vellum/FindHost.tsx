/**
 * FindHost — React shell mounted in vellum's Find tab slot.
 *
 * Mirrors `KanbanHost`'s pattern: a portolan-owned shell that mounts inside
 * vellum's tab slot, lazy on tab-enter. Stage A landed the empty shell;
 * Stage B (this file) renders the cross-project Fibers tree against
 * `/global-fibers`. Future stages add Spatial (D), Files (E), Search (C),
 * Git (F), Recents (G) sections per
 * [[ai-futures/portolan/design/constitution-portolan-navigation-layer]].
 *
 * Scope is communicated by `cityId`: undefined → global Find (cross-project
 * entry point hit when `/` is pressed without a focused city); set →
 * city-scoped Find. Today the only behavioural difference is auto-expand
 * of the focused city's group; once Stages D/E/F land, scope will gate
 * which sections render and where they aggregate.
 */

import { useEffect, useMemo, useState } from 'react'
import { fiberStatusIcon } from '../ui/utils'
import { getPortolanMountContext } from './mount'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

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
  onOpenFiberInCity,
}: {
  cityId?: string
  cityName?: string
  /** Reserved for Stage D (Spatial section): focus a worker's kitty tab
   *  when the user clicks its bird. Unused in Stage B. */
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

  // Resolve city name + path + gitStatus for any cityId in the response.
  // mountContext is module-scoped in mount.tsx; reading at render-time
  // picks up the latest state-sync push automatically. Re-reads on every
  // refresh tick so the Git section reflects the latest poll result without
  // needing a frame-driven WS subscription inside FindHost itself.
  const cityById = useMemo(() => {
    const ctx = getPortolanMountContext()
    if (!ctx)
      return new Map<
        string,
        {
          name?: string
          path: string
          originId: string
          gitStatus?: CityGitStatus
        }
      >()
    return new Map(ctx.getCities().map((c) => [c.id, c]))
  }, [data, refreshTick])

  // Build the row list for the Git section: every local city we know about,
  // sorted with the focused city first then alphabetical. Remote cities are
  // omitted — gitStatus doesn't ride the snapshot wire today. We render the
  // section regardless (so a "no git" empty-state surfaces) but only iterate
  // local cities for rows.
  const gitCities = useMemo<GitSectionCity[]>(() => {
    const ctx = getPortolanMountContext()
    if (!ctx) return []
    const rows: GitSectionCity[] = []
    for (const c of ctx.getCities()) {
      if (c.originId !== 'local') continue
      const displayName = c.name ?? c.path.split('/').pop() ?? c.id
      rows.push({ cityId: c.id, displayName, gitStatus: c.gitStatus })
    }
    rows.sort((a, b) => {
      if (cityId) {
        if (a.cityId === cityId && b.cityId !== cityId) return -1
        if (b.cityId === cityId && a.cityId !== cityId) return 1
      }
      return a.displayName.localeCompare(b.displayName)
    })
    return rows
  }, [cityId, refreshTick, data])

  // Sections collapse/expand state, indexed by stable group key. Default:
  // every group collapsed except the focused city's, which auto-expands
  // on first render so the user lands on something usable.
  const [openCityKeys, setOpenCityKeys] = useState<Set<string>>(() =>
    cityId ? new Set([`local::${cityId}`]) : new Set(),
  )
  // Per-fiber expanded state for the "one expand level" the constitution
  // permits in the Find trees. Keyed by `${groupKey}::${fiberId}` so two
  // cities with the same project-relative slug don't collide.
  const [openFiberKeys, setOpenFiberKeys] = useState<Set<string>>(new Set())

  // If the focused city changes (e.g. user opened Find in a different
  // city than the one we previously mounted with), auto-expand the new
  // one. Don't collapse the previously-open city — the user might still
  // want to see it; this matches the kanban tab's "additive" feel.
  useEffect(() => {
    if (!cityId) return
    setOpenCityKeys((prev) => {
      const key = `local::${cityId}`
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [cityId])

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
          maxWidth: '52rem',
          margin: '0 auto',
          padding: '1.75rem 1.5rem 4rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        <Eyebrow cityId={cityId} cityName={cityName} onRefresh={() => setRefreshTick((n) => n + 1)} />
        <FibersSection
          loading={loading}
          error={error}
          data={data}
          cityById={cityById}
          focusedCityId={cityId}
          openCityKeys={openCityKeys}
          setOpenCityKeys={setOpenCityKeys}
          openFiberKeys={openFiberKeys}
          setOpenFiberKeys={setOpenFiberKeys}
          onOpenFiberInCity={onOpenFiberInCity}
        />
        <GitSection cities={gitCities} focusedCityId={cityId} />
        <FutureSectionsNote />
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
  cityId,
  cityName,
  onRefresh,
}: {
  cityId?: string
  cityName?: string
  onRefresh: () => void
}): JSX.Element {
  const scope = cityId ? (cityName ?? cityId) : 'global'
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
      // CityHUDContent does for closed parents.
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
 * FutureSectionsNote — visible reminder of what's coming so the placeholder
 * text from Stage A doesn't disappear silently. Removed once the dashboard
 * fills in (Stages C–G).
 * ------------------------------------------------------------------------ */

function FutureSectionsNote(): JSX.Element {
  return (
    <div
      style={{
        fontSize: '0.7rem',
        opacity: 0.45,
        lineHeight: 1.5,
        borderTop: '1px dashed var(--border-muted, #E5DFD5)',
        paddingTop: '0.75rem',
      }}
    >
      Coming in subsequent stages: Spatial · Files · Search (cross-cutting fibers + files) ·
      Recents. See [[ai-futures/portolan/design/constitution-portolan-navigation-layer]].
    </div>
  )
}

/* ------------------------------------------------------------------------ *
 * GitSection — per-city git status (Stage F). Lifted from
 * `CityHUDHeader.renderGitDetail`. The HUD's per-city layout stacks here:
 * one row per local city, with the focused city pinned to the top. Global
 * scope shows the same stack (the constitution's "noisy is acceptable —
 * the user wanted it in"); city scope auto-collapses non-focused cities
 * behind their headers.
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
 * Visual choice: keep the inline-style React idiom from the rest of
 * FindHost rather than re-using `.hud-gd-*` classes from CityHUDHeader.
 * Reasons:
 *   - The HUD CSS lives in index.html and styles a fixed-position panel;
 *     rendering inside vellum's modal would inherit overlay styling we
 *     don't want.
 *   - Find's color tokens (--text, --text-muted, --border-muted) and the
 *     HUD's (--ink-body, --ink-faded, --parchment-edge) overlap in intent
 *     but use different identifiers; matching FindHost's existing palette
 *     keeps the section visually coherent with Fibers above it.
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
    const time = status.lastCommitTime ? relativeTime(status.lastCommitTime) : null
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

function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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
  `
  document.head.appendChild(style)
}
