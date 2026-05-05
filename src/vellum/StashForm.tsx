/**
 * StashForm — vellum's inline fiber stash modal.
 *
 * Realizes [[ai-futures/portolan/vellum-reader/constitution-stash-button]]:
 * a `+` button (or `n` hotkey) inside vellum's workspace tab opens this
 * form, the user types a title (and optionally body, tags, parent path),
 * chooses dispatch settings, and on save it POSTs `/fiber/create` which
 * shells out to `felt add` + `shuttle-ctl install/repeat`.
 *
 *   - No agent in the loop during stash. This just files + installs the
 *     shuttle block. Dispatch is the kanban's job.
 *   - Every stash is a constitution: a fiber with a shuttle: block that
 *     lands in the kanban's Drafts column (oneshot, enabled=false) or
 *     directly in InFlight as a standing role (enabled=true, scheduled).
 *   - The old "Make this a constitution" toggle is gone — there is no
 *     other kind of stash.
 *
 * Layout: a centered card over a scrim, ~760px wide and laid out in three
 * named bands — WHERE (project + parent), WHAT (title, body, tags), and
 * DISPATCH (agent + kind, with schedule appearing as a single inline row
 * when kind=standing). Horizontal pairing keeps the form short enough to
 * fit a 700-900px viewport without scrolling; the body textarea defaults
 * to 3 rows but resizes vertically. The card itself caps at the viewport
 * height with internal scroll on the body so the footer stays anchored.
 *
 * The scrim is a viewport-level `position: fixed; inset: 0` overlay at
 * z-index 10001 — above vellum's modal scrim (9999) and the thumb-index
 * column. Originally the scrim was `position: absolute` inside the kanban
 * host on the assumption that the host fully covered the viewport, but
 * vellum's thumb-index has a higher stacking context than the kanban
 * host and clipped the form's top-right corner. The kanban host's own
 * pointer-events trap still blocks map interactions underneath; we don't
 * need an additional `lockModalBackground()` here. Esc closes;
 * Cmd/Ctrl+Enter submits.
 */

import { useEffect, useRef, useState } from 'react'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  id: string
  model?: string
  cli?: string
  default: boolean
}

export interface StashFormProps {
  /**
   * Path to the city root (the directory containing `.felt/`). When the
   * host knows the city it threads its `path` here. Used as the *default*
   * destination for the city picker (matched to a city in `availableCities`
   * by path); the user can switch to any other city or to loom root before
   * submit. Optional: when null and no city is matched, the form fetches
   * the kanban's `feltHost` (~/loom by default) from /kanban and uses that
   * as the loom-root fallback.
   */
  cityPath?: string | null
  /**
   * Origin id for the felt invocation. `local` for filesystem hosts;
   * `remote-<host>` proxies through SSH. Defaults to `local` when omitted.
   * Used only as a default when `cityPath` matches a city in
   * `availableCities`; the picker carries each city's own originId.
   */
  originId?: string
  /**
   * All connected cities (local + remote). Surfaced as a combobox so the
   * user can choose where the new fiber lands. Each city carries its own
   * originId so remote stashing routes through the right portolan-agent
   * without the form having to thread `originId` separately. Empty array
   * = picker isn't rendered (form falls through to `cityPath`).
   */
  availableCities?: Array<{
    id: string
    name?: string
    path: string
    originId: string
  }>
  /**
   * Optional activity timestamps per city, used to sort the picker by
   * recency (most recently touched first). Map keyed by `cityId`; the
   * value is the unix-ms of the most recent worker activity in that city.
   * Cities not in the map sort to the bottom alphabetically. Threaded
   * from KanbanHost which derives this from `mountContext.getSessions()`.
   * Omitted = falls back to alphabetical.
   */
  cityActivityById?: Record<string, number>
  /**
   * Optional default parent slug. Per the constitution: "default = current
   * vellum context (e.g., the fiber being viewed) or a configurable global
   * default like `inbox/`." The kanban tab has no current fiber, so the
   * caller decides — for now we leave it empty (top-level) when null.
   */
  defaultParentSlug?: string | null
  /**
   * Existing tag set, surfaced from the most recent /kanban response.
   * The form falls back to fetching its own copy when this is empty so
   * a hot-mount has something to autocomplete against.
   */
  tagSuggestions?: string[]
  /** Called after a successful save with the new fiber id. */
  onCreated: (fiberId: string) => void
  /** Called on Esc / cancel / backdrop click. */
  onCancel: () => void
}

interface CreateFiberResponse {
  success: boolean
  fiberId?: string
  slug?: string
  shuttleInstalled?: boolean
  shuttleSkipped?: string
  shuttleError?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugify preview — mirrors the server's rule (kebab-case, lowercased,
 * non-alphanum collapsed, leading/trailing hyphens stripped, capped at 60).
 * Surfaced as a hint under the title so the user sees the slug they're
 * about to file under.
 */
function previewSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || 'stash-…'
}

/**
 * Validate a parent-fiber slug. Felt slugs are kebab-case ASCII with optional
 * `/`-separated nesting (e.g. `shuttle`, `vellum-reader/constitution-stash-
 * button`). They are NOT filesystem paths — leading `~`, leading `/`, `..`
 * segments, spaces, and other path-shaped characters silently get embedded
 * into the .felt/ tree as literal directory names if they slip through, which
 * produces a fiber that the kanban can show but the loader can't open
 * ("Fiber ~/Documents/… not found in this collection"). See
 * vellum-reader/constitution-stash-button/finding-trigger-relocated-to-header
 * for the trip into that hole.
 *
 * Returns null when the slug is well-formed, otherwise a human-readable
 * error message that can be surfaced under the field.
 */
function validateParentSlug(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null // empty = top-level, perfectly fine
  if (s.startsWith('~') || s.startsWith('/') || s.startsWith('.')) {
    return 'Parent is a fiber slug (e.g. shuttle), not a filesystem path.'
  }
  if (s.includes('..')) {
    return 'Parent slug cannot contain `..`.'
  }
  // Allow lowercase letters, digits, hyphens, and `/` as the nesting separator.
  // Underscores and uppercase aren't part of felt's slug rule; reject early
  // so the user gets a clear error rather than a 400 from the server.
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(s)) {
    return 'Parent slug must be kebab-case (lowercase letters, digits, hyphens, optional `/` for nesting).'
  }
  return null
}

/** Human-readable label for an agent entry. */
function agentLabel(a: AgentEntry): string {
  return a.model ? `${a.id} · ${a.model}` : a.id
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StashForm({
  cityPath,
  originId = 'local',
  availableCities = [],
  cityActivityById = {},
  defaultParentSlug,
  tagSuggestions,
  onCreated,
  onCancel,
}: StashFormProps): JSX.Element {
  // Core stash fields
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [parentSlug, setParentSlug] = useState<string>(defaultParentSlug ?? '')

  // Dispatch fields (shuttle)
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [agentId, setAgentId] = useState<string>('') // '' = registry default
  const [kind, setKind] = useState<'oneshot' | 'standing'>('oneshot')
  const [schedule, setSchedule] = useState<string>('')
  const [scheduleTz, setScheduleTz] = useState<string>('Europe/Paris')

  // Form state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedTags, setFetchedTags] = useState<string[]>([])

  // Loom-root fallback for global stash (when cityPath wasn't threaded
  // *and* no city is selected in the picker). Read from /kanban's
  // `feltHost` field once, on first open.
  const [fallbackFeltHost, setFallbackFeltHost] = useState<string | null>(null)

  // City picker state. Always picks a *project* — the loom-root
  // distinction was confusing more than it helped (Cail's fibers all
  // live under a project root). Default selection priority:
  //   1. The city in `availableCities` whose `path` matches the
  //      `cityPath` prop (kanban tab opens scoped to its own city).
  //   2. The most-recently-active city per `cityActivityById` — gives
  //      the global-kanban case a default that matches what the user
  //      was just working in.
  //   3. The first city alphabetically — fallback when no activity is
  //      recorded yet.
  //   4. `null` — only if `availableCities` is empty, in which case the
  //      picker isn't rendered and the form falls through to
  //      `cityPath`/`fallbackFeltHost`.
  const [selectedCityId, setSelectedCityId] = useState<string | null>(() => {
    if (cityPath) {
      const match = availableCities.find((c) => c.path === cityPath)
      if (match) return match.id
    }
    if (availableCities.length === 0) return null
    // Most-recently-active city wins. Cities without an entry in the
    // activity map count as 0 — they sort behind any city with activity.
    const ranked = [...availableCities].sort((a, b) => {
      const recencyDelta = (cityActivityById[b.id] ?? 0) - (cityActivityById[a.id] ?? 0)
      if (recencyDelta !== 0) return recencyDelta
      return (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' })
    })
    return ranked[0].id
  })
  const [cityPickerOpen, setCityPickerOpen] = useState(false)
  const [cityFilter, setCityFilter] = useState('')

  const titleRef = useRef<HTMLInputElement | null>(null)
  const cityPickerRef = useRef<HTMLDivElement | null>(null)

  // Autofocus the title on first paint — title is required, and the
  // user pressed `+` / `n` to start writing.
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Fetch /kanban once on mount to pick up the tagIndex (autocomplete) and
  // the loom feltHost (cityPath fallback when the form is opened from the
  // global view). Also fetch /shuttle/agents for the dispatch dropdown.
  // Both are best-effort — absence is degraded UX, not a blocker.
  useEffect(() => {
    let cancelled = false

    // Tags + feltHost from /kanban
    if (!(tagSuggestions && tagSuggestions.length > 0 && cityPath)) {
      fetch(`${API_BASE}/kanban`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { tagIndex?: string[]; feltHost?: string } | null) => {
          if (cancelled || !data) return
          if (data.tagIndex) setFetchedTags(data.tagIndex)
          if (data.feltHost) setFallbackFeltHost(data.feltHost)
        })
        .catch(() => {})
    }

    // Agent registry from shuttle
    fetch(`${API_BASE}/shuttle/agents`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { agents?: AgentEntry[] } | null) => {
        if (cancelled || !data?.agents?.length) return
        setAgents(data.agents)
        // Pre-select the default agent
        const def = data.agents.find((a) => a.default)
        if (def) setAgentId(def.id)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [tagSuggestions, cityPath])

  // Close the city dropdown when the user clicks anywhere outside the picker.
  useEffect(() => {
    if (!cityPickerOpen) return
    const handleDown = (e: MouseEvent): void => {
      const root = cityPickerRef.current
      if (root && !root.contains(e.target as Node)) {
        setCityPickerOpen(false)
        setCityFilter('')
      }
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [cityPickerOpen])

  // Sort cities by recent activity, then alphabetically as the tiebreaker.
  const sortedCities = [...availableCities].sort((a, b) => {
    const recencyDelta = (cityActivityById[b.id] ?? 0) - (cityActivityById[a.id] ?? 0)
    if (recencyDelta !== 0) return recencyDelta
    return (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' })
  })
  const cityFilterLower = cityFilter.trim().toLowerCase()
  const filteredCities = cityFilterLower
    ? sortedCities.filter((c) =>
        (c.name ?? c.id).toLowerCase().includes(cityFilterLower) ||
        c.originId.toLowerCase().includes(cityFilterLower),
      )
    : sortedCities

  const selectedCityLabel = (() => {
    if (selectedCityId === null) return ''
    const c = availableCities.find((x) => x.id === selectedCityId)
    if (!c) return ''
    const remoteSuffix = c.originId === 'local' ? '' : ` · ${c.originId}`
    return `${c.name ?? c.id}${remoteSuffix}`
  })()

  const allSuggestions = (tagSuggestions && tagSuggestions.length > 0 ? tagSuggestions : fetchedTags) ?? []
  const tagInputLower = tagInput.trim().toLowerCase()
  const filteredSuggestions = allSuggestions
    .filter((t) => !tags.includes(t))
    .filter((t) => (tagInputLower ? t.toLowerCase().includes(tagInputLower) : true))
    .slice(0, 8)

  const addTag = (raw: string): void => {
    const t = raw.trim()
    if (!t) return
    if (tags.includes(t)) return
    setTags([...tags, t])
    setTagInput('')
  }

  const removeTag = (t: string): void => {
    setTags(tags.filter((x) => x !== t))
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(tagInput)
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('Title is required')
      titleRef.current?.focus()
      return
    }
    const parentError = validateParentSlug(parentSlug)
    if (parentError) {
      setError(parentError)
      return
    }
    if (kind === 'standing' && !schedule.trim()) {
      setError('Schedule (cron expression) is required for standing roles.')
      return
    }

    const selectedCity =
      selectedCityId !== null
        ? availableCities.find((c) => c.id === selectedCityId) ?? null
        : null
    const effectiveCityPath = selectedCity?.path ?? cityPath ?? fallbackFeltHost
    const effectiveOriginId = selectedCity?.originId ?? originId
    if (!effectiveCityPath) {
      setError('Loom path not yet resolved — try again in a moment, or pick a city.')
      return
    }

    setSubmitting(true)
    setError(null)

    // Tags are purely cosmetic — no constitution/draft synthesis.
    const finalTags = [...tags]

    try {
      const body_obj: Record<string, unknown> = {
        originId: effectiveOriginId,
        cityPath: effectiveCityPath,
        title: trimmedTitle,
        body: body.length > 0 ? body : undefined,
        tags: finalTags.length > 0 ? finalTags : undefined,
        parentSlug: parentSlug.trim() || undefined,
        agent: agentId || undefined,
        kind,
      }
      if (kind === 'standing') {
        body_obj.schedule = schedule.trim()
        body_obj.tz = scheduleTz.trim() || 'UTC'
      }

      const res = await fetch(`${API_BASE}/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body_obj),
      })
      const data = (await res.json().catch(() => ({}))) as CreateFiberResponse
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Server returned ${res.status}`)
      }
      onCreated(data.fiberId ?? data.slug ?? '')
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err)
      setError(msg)
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  // Default agent label for the select placeholder
  const defaultAgentEntry = agents.find((a) => a.default)
  const defaultAgentLabel = defaultAgentEntry ? agentLabel(defaultAgentEntry) : 'default'
  const parentValidation = validateParentSlug(parentSlug)

  return (
    <div
      className="stash-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="stash-card"
        role="dialog"
        aria-modal="true"
        aria-label="Stash a new fiber"
      >
        <div className="stash-header">
          <div className="stash-header-row">
            <h2 className="stash-title">Stash a constitution</h2>
            <span className="stash-eyebrow">vellum · kanban</span>
          </div>
          <div className="stash-subtitle">
            Drop an idea. Lands in Drafts — promote to dispatch via the kanban.
          </div>
          <span className="stash-header-rule" aria-hidden="true" />
        </div>

        <div className="stash-body">
          {/* ── Section: WHERE — project + parent fiber ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">Where</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>
            <div className="stash-row stash-row-2">
              {/* Project picker */}
              {availableCities.length > 0 && (
                <div className="stash-field">
                  <span className="stash-label">Project</span>
                  <div className="stash-city-picker" ref={cityPickerRef}>
                    <input
                      type="text"
                      className="stash-input"
                      value={cityPickerOpen ? cityFilter : selectedCityLabel}
                      onFocus={() => setCityPickerOpen(true)}
                      onClick={() => setCityPickerOpen(true)}
                      onChange={(e) => setCityFilter(e.target.value)}
                      readOnly={!cityPickerOpen}
                      placeholder="search projects…"
                      aria-haspopup="listbox"
                      aria-expanded={cityPickerOpen}
                    />
                    {cityPickerOpen && (
                      <div className="stash-city-list" role="listbox">
                        {filteredCities.map((c) => (
                          <button
                            key={`${c.originId}:${c.id}`}
                            type="button"
                            className={
                              selectedCityId === c.id
                                ? 'stash-city-option stash-city-option-active'
                                : 'stash-city-option'
                            }
                            role="option"
                            aria-selected={selectedCityId === c.id}
                            onClick={() => {
                              setSelectedCityId(c.id)
                              setCityPickerOpen(false)
                              setCityFilter('')
                            }}
                          >
                            <span>{c.name ?? c.id}</span>
                            <span className="stash-city-meta">
                              {c.originId === 'local' ? c.path : `${c.originId} · ${c.path}`}
                            </span>
                          </button>
                        ))}
                        {filteredCities.length === 0 && cityFilterLower && (
                          <div className="stash-city-empty">
                            No connected city matches "{cityFilter}".
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Parent fiber */}
              <label className="stash-field">
                <span className="stash-label">
                  Parent fiber <span className="stash-optional">opt</span>
                </span>
                <input
                  type="text"
                  className="stash-input"
                  value={parentSlug}
                  onChange={(e) => setParentSlug(e.target.value)}
                  placeholder="shuttle  ·  vellum-reader/…"
                />
              </label>
            </div>
            {parentValidation && (
              <div className="stash-hint stash-hint-warn">{parentValidation}</div>
            )}
          </section>

          {/* ── Section: WHAT — title, body, tags ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">What</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>

            {/* Title */}
            <label className="stash-field">
              <span className="stash-label">Title</span>
              <input
                ref={titleRef}
                type="text"
                className="stash-input stash-input-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Look into garden lens"
                required
                maxLength={200}
              />
              {title.trim() && (
                <div className="stash-receipt">
                  <span className="stash-receipt-key">slug</span>
                  <span className="stash-receipt-sep">›</span>
                  <code className="stash-receipt-val">
                    {parentSlug ? `${parentSlug}/` : ''}{previewSlug(title)}
                  </code>
                </div>
              )}
            </label>

            {/* Body */}
            <label className="stash-field">
              <span className="stash-label">
                Body <span className="stash-optional">opt</span>
              </span>
              <textarea
                className="stash-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Free-form blabbing — paragraphs, code, whatever. Skip if title is enough."
                rows={3}
              />
            </label>

            {/* Tags */}
            <div className="stash-field">
              <span className="stash-label">
                Tags <span className="stash-optional">opt</span>
              </span>
              <div className="stash-chips">
                {tags.map((t) => (
                  <span key={t} className="stash-chip">
                    {t}
                    <button
                      type="button"
                      className="stash-chip-x"
                      onClick={() => removeTag(t)}
                      aria-label={`Remove tag ${t}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  className="stash-tag-input"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  placeholder={tags.length === 0 ? 'tag, then Enter' : ''}
                />
              </div>
              {filteredSuggestions.length > 0 && tagInput && (
                <div className="stash-suggestions" role="listbox">
                  {filteredSuggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="stash-suggestion"
                      onClick={() => addTag(t)}
                      role="option"
                      aria-selected="false"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ── Section: DISPATCH — agent + kind (+ schedule when standing) ── */}
          <section className="stash-section">
            <div className="stash-section-head">
              <span className="stash-section-label">Dispatch</span>
              <span className="stash-section-rule" aria-hidden="true" />
            </div>
            <div className="stash-row stash-row-2">
              {/* Agent */}
              <div className="stash-field">
                <span className="stash-label">Agent</span>
                {agents.length > 0 ? (
                  <select
                    className="stash-select"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    <option value="">Default ({defaultAgentLabel})</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentLabel(a)}{a.default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="stash-input"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder="claude-sonnet (default)"
                  />
                )}
              </div>

              {/* Kind — segmented control, horizontal */}
              <div className="stash-field">
                <span className="stash-label">Kind</span>
                <div className="stash-segmented" role="radiogroup" aria-label="Dispatch kind">
                  <label
                    className={
                      kind === 'oneshot'
                        ? 'stash-segment stash-segment-active'
                        : 'stash-segment'
                    }
                  >
                    <input
                      type="radio"
                      name="stash-kind"
                      value="oneshot"
                      checked={kind === 'oneshot'}
                      onChange={() => setKind('oneshot')}
                    />
                    <span className="stash-segment-name">One-shot</span>
                    <span className="stash-segment-hint">drafts, manual launch</span>
                  </label>
                  <label
                    className={
                      kind === 'standing'
                        ? 'stash-segment stash-segment-active'
                        : 'stash-segment'
                    }
                  >
                    <input
                      type="radio"
                      name="stash-kind"
                      value="standing"
                      checked={kind === 'standing'}
                      onChange={() => setKind('standing')}
                    />
                    <span className="stash-segment-name">Standing</span>
                    <span className="stash-segment-hint">cron-scheduled role</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Schedule + timezone, only when kind=standing — single inline row */}
            {kind === 'standing' && (
              <div className="stash-row stash-row-schedule">
                <label className="stash-field stash-field-cron">
                  <span className="stash-label">Schedule</span>
                  <input
                    type="text"
                    className="stash-input stash-input-mono"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder="0 9 * * 1-5"
                    required
                  />
                  <div className="stash-hint">
                    5-field cron · e.g. <code>0 9 * * 1-5</code> (weekdays 09:00)
                  </div>
                </label>
                <label className="stash-field stash-field-tz">
                  <span className="stash-label">Timezone</span>
                  <input
                    type="text"
                    className="stash-input"
                    value={scheduleTz}
                    onChange={(e) => setScheduleTz(e.target.value)}
                    placeholder="Europe/Paris"
                  />
                  <div className="stash-hint">IANA name</div>
                </label>
              </div>
            )}
          </section>

          {/* ── Error ── */}
          {error && (
            <div className="stash-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="stash-footer">
          <div className="stash-hint stash-hint-foot">
            <kbd>Esc</kbd> cancel <span className="stash-hint-dot">·</span> <kbd>⌘↵</kbd> save
          </div>
          <div className="stash-buttons">
            <button
              type="button"
              className="stash-btn stash-btn-cancel"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="stash-btn stash-btn-save"
              onClick={() => void submit()}
              disabled={submitting || !title.trim()}
            >
              {submitting ? 'Stashing…' : 'Stash'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Inject the StashForm's CSS once. Idempotent — safe to call on every
 * KanbanHost mount. Kept as a sibling stylesheet rather than inline so
 * the React tree stays lean and the styles can be inspected via the
 * standard browser-tools path.
 */
export function injectStashFormStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('stash-form-styles')) return
  const style = document.createElement('style')
  style.id = 'stash-form-styles'
  style.textContent = `
    /* ───────────────────────────────────────────────────────────────
       Scrim — viewport-level fixed overlay so it clears vellum's
       thumb-index (which has a higher stacking context than the kanban
       host). z-index 10001 sits one above the .vellum-modal-scrim at
       9999 (per portolan's modal z-index conventions in CLAUDE.md).
       Card caps at viewport height; only its body scrolls so the
       header (anchor) and footer (controls) stay in view.
       ─────────────────────────────────────────────────────────────── */
    .stash-scrim {
      position: fixed;
      inset: 0;
      background: rgba(46, 42, 38, 0.45);
      z-index: 10001;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 20px 20px;
      overflow: auto;
      animation: stash-scrim-in 120ms ease-out;
    }
    @keyframes stash-scrim-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .stash-card {
      width: 100%;
      max-width: 760px;
      max-height: calc(100vh - 80px);
      background: #F4F0E8;
      /* Subtle parchment grain via two stacked diagonal washes. */
      background-image:
        linear-gradient(135deg, rgba(154, 123, 53, 0.025) 0%, transparent 60%),
        linear-gradient(315deg, rgba(46, 42, 38, 0.020) 0%, transparent 70%);
      border: 1px solid rgba(46, 42, 38, 0.22);
      border-radius: 4px;
      box-shadow:
        0 1px 0 rgba(255, 252, 245, 0.6) inset,
        0 14px 36px rgba(46, 42, 38, 0.26),
        0 2px 6px rgba(46, 42, 38, 0.12);
      font-family: var(--font-main, 'EB Garamond', serif);
      color: #2E2A26;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: stash-card-in 160ms ease-out;
    }
    @keyframes stash-card-in {
      from { transform: translateY(-6px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    /* ───────────────────────────────────────────────────────────────
       Header — leather band with a thin gold rule beneath.
       ─────────────────────────────────────────────────────────────── */
    .stash-header {
      position: relative;
      padding: 14px 22px 12px;
      background: #E5DED2;
      border-bottom: 1px solid rgba(46, 42, 38, 0.10);
      flex: none;
    }
    .stash-header-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .stash-title {
      margin: 0;
      font-size: 19px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .stash-eyebrow {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #9A8E80;
    }
    .stash-subtitle {
      font-style: italic;
      font-size: 13px;
      color: #7A7068;
      margin-top: 2px;
    }
    /* Hairline gold rule under the header — a single cartographic accent. */
    .stash-header-rule {
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 1px;
      background: linear-gradient(
        to right,
        transparent 0%,
        rgba(154, 123, 53, 0.0) 6%,
        rgba(154, 123, 53, 0.55) 50%,
        rgba(154, 123, 53, 0.0) 94%,
        transparent 100%
      );
    }

    /* ───────────────────────────────────────────────────────────────
       Body — scrollable region between the fixed header & footer.
       ─────────────────────────────────────────────────────────────── */
    .stash-body {
      padding: 14px 22px 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
      flex: 1 1 auto;
    }

    /* Section: small all-caps label + horizontal hairline rule. */
    .stash-section {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .stash-section-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .stash-section-label {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #9A7B35;
      flex: none;
    }
    .stash-section-rule {
      flex: 1;
      height: 1px;
      background: linear-gradient(
        to right,
        rgba(46, 42, 38, 0.18) 0%,
        rgba(46, 42, 38, 0.05) 100%
      );
    }

    /* Horizontal pairing — two columns when there's room, stacks below. */
    .stash-row {
      display: grid;
      gap: 12px;
    }
    .stash-row-2 {
      grid-template-columns: 1fr 1fr;
    }
    .stash-row-schedule {
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      margin-top: 2px;
    }
    @media (max-width: 600px) {
      .stash-row-2,
      .stash-row-schedule {
        grid-template-columns: 1fr;
      }
    }

    /* ───────────────────────────────────────────────────────────────
       Fields — labels, inputs, hints.
       ─────────────────────────────────────────────────────────────── */
    .stash-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .stash-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #5C544D;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    .stash-optional {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9.5px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #B5A998;
      padding: 0 4px;
      border: 1px solid rgba(46, 42, 38, 0.10);
      border-radius: 2px;
    }
    .stash-input,
    .stash-textarea,
    .stash-tag-input,
    .stash-select {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      color: #2E2A26;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      padding: 6px 9px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
      width: 100%;
      box-sizing: border-box;
    }
    .stash-input-title {
      font-size: 17px;
      padding: 7px 10px;
    }
    .stash-select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237A7068'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 28px;
      cursor: pointer;
    }
    .stash-input-mono {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 13px;
      letter-spacing: 0.02em;
    }
    .stash-textarea {
      resize: vertical;
      min-height: 64px;
      font-family: var(--font-main, 'EB Garamond', serif);
      line-height: 1.45;
    }
    .stash-input:focus,
    .stash-textarea:focus,
    .stash-tag-input:focus,
    .stash-select:focus {
      outline: none;
      border-color: #9A7B35;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-hint {
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
    }
    .stash-hint code {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      font-style: normal;
      background: rgba(46, 42, 38, 0.06);
      padding: 1px 5px;
      border-radius: 2px;
    }
    .stash-hint-warn {
      color: #8C5A1A;
      font-style: normal;
      font-size: 12px;
    }

    /* Slug receipt — a typewriter-style hint under the title. */
    .stash-receipt {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      margin-top: 2px;
      padding: 2px 8px;
      background: rgba(255, 252, 245, 0.7);
      border: 1px dashed rgba(154, 123, 53, 0.42);
      border-radius: 2px;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      color: #5C544D;
    }
    .stash-receipt-key {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #9A7B35;
      font-size: 9.5px;
    }
    .stash-receipt-sep {
      color: #B5A998;
    }
    .stash-receipt-val {
      font-family: inherit;
      color: #2E2A26;
      background: transparent;
      padding: 0;
    }

    /* ───────────────────────────────────────────────────────────────
       Tag chips + autocomplete suggestions.
       ─────────────────────────────────────────────────────────────── */
    .stash-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      min-height: 34px;
    }
    .stash-chips:focus-within {
      border-color: #9A7B35;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 4px 2px 8px;
      background: rgba(154, 123, 53, 0.14);
      border: 1px solid rgba(154, 123, 53, 0.32);
      border-radius: 12px;
      font-size: 12px;
      color: #5A4520;
    }
    .stash-chip-x {
      background: transparent;
      border: 0;
      color: #5A4520;
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
      line-height: 1;
      border-radius: 50%;
    }
    .stash-chip-x:hover {
      background: rgba(178, 78, 60, 0.18);
      color: #8B3A28;
    }
    .stash-tag-input {
      flex: 1;
      min-width: 100px;
      border: 0;
      padding: 2px 4px;
      background: transparent;
      box-shadow: none !important;
    }
    .stash-tag-input:focus {
      box-shadow: none;
    }
    .stash-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .stash-suggestion {
      background: rgba(46, 42, 38, 0.05);
      border: 1px solid rgba(46, 42, 38, 0.14);
      color: #2E2A26;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 100ms ease-out;
    }
    .stash-suggestion:hover {
      background: rgba(154, 123, 53, 0.18);
      border-color: rgba(154, 123, 53, 0.42);
    }

    /* ───────────────────────────────────────────────────────────────
       City picker — combobox with searchable dropdown.
       ─────────────────────────────────────────────────────────────── */
    .stash-city-picker {
      position: relative;
    }
    .stash-city-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 10;
      max-height: 240px;
      overflow-y: auto;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.18);
      border-radius: 3px;
      box-shadow: 0 8px 18px rgba(46, 42, 38, 0.18);
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .stash-city-option {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 7px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      color: #2E2A26;
      text-align: left;
      cursor: pointer;
      transition: background 100ms ease-out;
    }
    .stash-city-option:hover,
    .stash-city-option:focus-visible {
      background: rgba(154, 123, 53, 0.14);
      outline: none;
    }
    .stash-city-option-active {
      background: rgba(154, 123, 53, 0.22);
      border-color: rgba(154, 123, 53, 0.48);
    }
    .stash-city-meta {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10.5px;
      color: #7A7068;
      letter-spacing: 0.02em;
    }
    .stash-city-empty {
      padding: 8px 10px;
      font-size: 12px;
      color: #7A7068;
      font-style: italic;
    }

    /* ───────────────────────────────────────────────────────────────
       Kind segmented control — two side-by-side pills sharing a frame.
       Native radio is visually hidden but kept for a11y / form state.
       ─────────────────────────────────────────────────────────────── */
    .stash-segmented {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      padding: 3px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
    }
    .stash-segmented:focus-within {
      border-color: #9A7B35;
      box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
    }
    .stash-segment {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      padding: 5px 9px;
      border-radius: 2px;
      cursor: pointer;
      transition: background 120ms ease-out, color 120ms ease-out;
      color: #5C544D;
      min-width: 0;
    }
    .stash-segment input[type="radio"] {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 0;
      height: 0;
    }
    .stash-segment-name {
      font-size: 13px;
      font-weight: 600;
      color: inherit;
      line-height: 1.2;
    }
    .stash-segment-hint {
      font-size: 11px;
      font-style: italic;
      color: #9A8E80;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .stash-segment:hover {
      background: rgba(154, 123, 53, 0.08);
    }
    .stash-segment-active {
      background: rgba(154, 123, 53, 0.18);
      color: #5A4520;
      box-shadow: inset 0 0 0 1px rgba(154, 123, 53, 0.42);
    }
    .stash-segment-active .stash-segment-hint {
      color: #7A6028;
    }

    /* ───────────────────────────────────────────────────────────────
       Error band.
       ─────────────────────────────────────────────────────────────── */
    .stash-error {
      padding: 8px 10px;
      background: rgba(178, 78, 60, 0.12);
      border: 1px solid rgba(178, 78, 60, 0.5);
      color: #8B3A28;
      font-size: 13px;
      border-radius: 2px;
    }

    /* ───────────────────────────────────────────────────────────────
       Footer — anchored, never scrolls.
       ─────────────────────────────────────────────────────────────── */
    .stash-footer {
      padding: 10px 22px 14px;
      border-top: 1px solid rgba(46, 42, 38, 0.10);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: #EFEAE0;
      flex: none;
    }
    .stash-hint-foot {
      font-style: normal;
      color: #7A7068;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .stash-hint-dot {
      color: #B5A998;
    }
    .stash-hint-foot kbd {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      background: rgba(46, 42, 38, 0.10);
      padding: 1px 5px;
      border-radius: 2px;
      border: 1px solid rgba(46, 42, 38, 0.16);
      color: #4C453F;
    }
    .stash-buttons {
      display: flex;
      gap: 8px;
    }
    .stash-btn {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 14px;
      padding: 6px 16px;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out;
      letter-spacing: 0.01em;
    }
    .stash-btn-cancel {
      background: transparent;
      color: #7A7068;
      border-color: rgba(46, 42, 38, 0.20);
    }
    .stash-btn-cancel:hover:not(:disabled) {
      background: rgba(46, 42, 38, 0.06);
      color: #2E2A26;
    }
    .stash-btn-save {
      background: #9A7B35;
      color: #FFFFFF;
      border-color: #7A6028;
      box-shadow: 0 1px 0 rgba(255, 252, 245, 0.25) inset;
    }
    .stash-btn-save:hover:not(:disabled) {
      background: #B08D3D;
    }
    .stash-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Stash trigger lives inside KanbanModal's own header now
       (.kbn-stash-btn, styles colocated with the rest of the kanban
       header in src/ui/KanbanModal.ts). The previous floating
       .stash-trigger was anchored at right:380px assuming vellum's
       file-viewer thumb-index, which doesn't appear on the kanban tab —
       and FloatingIsland (z 500) ate the click area. The header position
       puts the affordance where users look (next to the title) and
       sidesteps the chrome stack entirely. */
  `
  document.head.appendChild(style)
}
