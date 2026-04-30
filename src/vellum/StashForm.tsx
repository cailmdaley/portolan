/**
 * StashForm — vellum's inline fiber stash modal.
 *
 * Realizes [[ai-futures/portolan/vellum-reader/constitution-stash-button]]:
 * a `+` button (or `n` hotkey) inside vellum's workspace tab opens this
 * form, the user types a title (and optionally body, tags, parent path),
 * and on save it POSTs `/fiber/create` which shells out to `felt add`.
 *
 *   - No agent in the loop. This is a stash, not a conversation.
 *   - Two flavours, same form: title-only quick stash, or title-with-body
 *     blab. Body is the only optional-vs-not differentiator; everything
 *     else (tags, parent, constitution toggle) is optional in either case.
 *   - Tags autocomplete from the existing tag set (read from /kanban's
 *     `tagIndex`); typing accepts new tags too.
 *   - "Make this a constitution" checkbox adds `constitution` + `draft`
 *     tags so the new fiber lands in the kanban's Drafts column,
 *     refinable before Shuttle picks it up. Per the constitution's open
 *     question — yes, ergonomic.
 *
 * Layout: a centered card over a scrim. The scrim sits inside the kanban
 * host (which already covers the workspace viewport via `position: fixed;
 * inset: 0`), so we don't need a second background lock — the host's
 * own pointer-events trap is sufficient. Esc closes; Cmd/Ctrl+Enter
 * submits.
 */

import { useEffect, useRef, useState } from 'react'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

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
   * user can choose where the new fiber lands. The `<select>`-style picker
   * defaults to the city whose `path` matches the `cityPath` prop, falling
   * back to "Loom root" (no project) when nothing matches. Each city
   * carries its own originId so remote stashing routes through the right
   * portolan-agent without the form having to thread `originId` separately.
   * Empty array = picker collapses to a static "Loom root" line.
   */
  availableCities?: Array<{
    id: string
    name?: string
    path: string
    originId: string
  }>
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
  error?: string
}

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

export function StashForm({
  cityPath,
  originId = 'local',
  availableCities = [],
  defaultParentSlug,
  tagSuggestions,
  onCreated,
  onCancel,
}: StashFormProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [parentSlug, setParentSlug] = useState<string>(defaultParentSlug ?? '')
  const [makeConstitution, setMakeConstitution] = useState(false)
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
  //   2. The first city in `availableCities` alphabetically — gives the
  //      global-kanban case a sensible default that the user can override.
  //   3. `null` — only if `availableCities` is empty, in which case the
  //      picker isn't rendered and the form falls through to
  //      `cityPath`/`fallbackFeltHost`.
  const [selectedCityId, setSelectedCityId] = useState<string | null>(() => {
    if (cityPath) {
      const match = availableCities.find((c) => c.path === cityPath)
      if (match) return match.id
    }
    if (availableCities.length === 0) return null
    const sorted = [...availableCities].sort((a, b) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' }),
    )
    return sorted[0].id
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
  // global view). Cheap — the kanban response is on the order of single-
  // digit kB and already cached server-side. Skipped only if the host
  // pre-threaded both pieces of info.
  useEffect(() => {
    if (tagSuggestions && tagSuggestions.length > 0 && cityPath) return
    let cancelled = false
    fetch(`${API_BASE}/kanban`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tagIndex?: string[]; feltHost?: string } | null) => {
        if (cancelled || !data) return
        if (data.tagIndex) setFetchedTags(data.tagIndex)
        if (data.feltHost) setFallbackFeltHost(data.feltHost)
      })
      .catch(() => {
        // Autocomplete absence is degraded UX, not a blocker — typed tags
        // still pass through. Submission absent a cityPath surfaces a real
        // error to the user.
      })
    return () => {
      cancelled = true
    }
  }, [tagSuggestions, cityPath])

  // Close the city dropdown when the user clicks anywhere outside the picker.
  // Bound to the document so clicking other form fields, the scrim, etc. all
  // collapse the menu — same idiom as the tag suggestions, just for a single-
  // select picker. Mounted only while the dropdown is open so the listener
  // isn't churning on every paint.
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

  // Sort cities by name (alphabetical, case-insensitive). Stable across
  // renders since `availableCities` is the source of truth, so the same
  // input → same order.
  const sortedCities = [...availableCities].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' }),
  )
  // Filter by typed cityFilter (substring match against name/id). Empty
  // filter = full list. Keeps the dropdown manageable as cities accumulate.
  const cityFilterLower = cityFilter.trim().toLowerCase()
  const filteredCities = cityFilterLower
    ? sortedCities.filter((c) =>
        (c.name ?? c.id).toLowerCase().includes(cityFilterLower) ||
        c.originId.toLowerCase().includes(cityFilterLower),
      )
    : sortedCities

  // Label rendered in the picker's collapsed state. The default initializer
  // always picks a city when `availableCities` is non-empty, so the empty-
  // selection case only fires when no cities are connected — in which case
  // the picker isn't rendered at all and the form falls through to
  // `cityPath`/`fallbackFeltHost`. The placeholder stays empty to keep the
  // input's natural `placeholder="search projects…"` visible.
  const selectedCityLabel = (() => {
    if (selectedCityId === null) return ''
    const c = availableCities.find((x) => x.id === selectedCityId)
    if (!c) return ''
    const remoteSuffix = c.originId === 'local' ? '' : ` · ${c.originId}`
    return `${c.name ?? c.id}${remoteSuffix}`
  })()

  const allSuggestions = (tagSuggestions && tagSuggestions.length > 0 ? tagSuggestions : fetchedTags) ?? []

  // Filter suggestions: prefix-match the current input, exclude already-
  // selected, cap at a sensible dropdown size. Empty input still shows
  // the top of the alphabet so the user can browse.
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
      // Backspace at empty input pops the last chip — standard chip-input UX.
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
    // Resolve the destination from the picker. Selected city → its own
    // path + originId. Loom root → fall through to the kanban's `feltHost`
    // (or the explicit `cityPath` prop if the host threaded one without
    // matching an entry in `availableCities`). The picker is the source
    // of truth for both location *and* origin: a remote city carries its
    // own `originId` so /fiber/create routes through the right
    // portolan-agent without the form needing to mix and match.
    const selectedCity =
      selectedCityId !== null
        ? availableCities.find((c) => c.id === selectedCityId) ?? null
        : null
    const effectiveCityPath = selectedCity?.path ?? cityPath ?? fallbackFeltHost
    const effectiveOriginId = selectedCity?.originId ?? originId
    if (!effectiveCityPath) {
      setError(
        'Loom path not yet resolved — try again in a moment, or pick a city.',
      )
      return
    }
    setSubmitting(true)
    setError(null)
    // Constitution toggle adds `constitution` + `draft` tags. The fiber
    // lands in the kanban's Drafts column — promotable to active by
    // dragging out of Drafts (which removes the `draft` tag and clears
    // closed-at).
    const finalTags = [...tags]
    if (makeConstitution) {
      if (!finalTags.includes('constitution')) finalTags.push('constitution')
      if (!finalTags.includes('draft')) finalTags.push('draft')
    }
    try {
      const res = await fetch(`${API_BASE}/fiber/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originId: effectiveOriginId,
          cityPath: effectiveCityPath,
          title: trimmedTitle,
          body: body.length > 0 ? body : undefined,
          tags: finalTags.length > 0 ? finalTags : undefined,
          parentSlug: parentSlug.trim() || undefined,
        }),
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

  // Modal-level keydown: Esc closes; Cmd/Ctrl+Enter submits.
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

  return (
    <div
      className="stash-scrim"
      onClick={(e) => {
        // Click on the scrim (not on the card) cancels.
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
          <h2 className="stash-title">Stash a fiber</h2>
          <div className="stash-subtitle">
            Drop an idea. No agent — this just files.
          </div>
        </div>

        <div className="stash-body">
          {availableCities.length > 0 && (
            <div className="stash-field">
              <span className="stash-label">Project</span>
              <div
                className="stash-city-picker"
                ref={cityPickerRef}
              >
                <input
                  type="text"
                  className="stash-input"
                  value={cityPickerOpen ? cityFilter : selectedCityLabel}
                  onFocus={() => setCityPickerOpen(true)}
                  onClick={() => setCityPickerOpen(true)}
                  onChange={(e) => setCityFilter(e.target.value)}
                  // readOnly when collapsed: the input shows the selection
                  // label as a button-like display. On focus, switches to the
                  // editable filter so type-to-search works without a mode
                  // toggle. Click anywhere on the row opens the menu.
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
              <div className="stash-hint">
                Project the new fiber lands in.
              </div>
            </div>
          )}

          <label className="stash-field">
            <span className="stash-label">Title</span>
            <input
              ref={titleRef}
              type="text"
              className="stash-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Look into garden lens"
              required
              maxLength={200}
            />
            {title.trim() && (
              <div className="stash-hint">
                slug: <code>{parentSlug ? `${parentSlug}/` : ''}{previewSlug(title)}</code>
              </div>
            )}
          </label>

          <label className="stash-field">
            <span className="stash-label">
              Body <span className="stash-optional">(optional)</span>
            </span>
            <textarea
              className="stash-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Free-form blabbing — paragraphs, code, whatever. Skip if title is enough."
              rows={5}
            />
          </label>

          <div className="stash-field">
            <span className="stash-label">
              Tags <span className="stash-optional">(optional)</span>
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

          <label className="stash-field">
            <span className="stash-label">
              Parent fiber <span className="stash-optional">(optional)</span>
            </span>
            <input
              type="text"
              className="stash-input"
              value={parentSlug}
              onChange={(e) => setParentSlug(e.target.value)}
              placeholder="e.g. shuttle  or  vellum-reader/constitution-stash-button"
            />
            {validateParentSlug(parentSlug) ? (
              <div className="stash-hint stash-hint-warn">
                {validateParentSlug(parentSlug)}
              </div>
            ) : (
              <div className="stash-hint">
                Existing fiber slug to nest under (kebab-case, `/` for deeper
                nesting). Leave empty for top-level.
              </div>
            )}
          </label>

          <label className="stash-checkbox-row">
            <input
              type="checkbox"
              checked={makeConstitution}
              onChange={(e) => setMakeConstitution(e.target.checked)}
            />
            <span>
              Make this a <strong>constitution</strong> (lands in Drafts)
            </span>
          </label>

          {error && (
            <div className="stash-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="stash-footer">
          <div className="stash-hint stash-hint-foot">
            <kbd>Esc</kbd> cancel · <kbd>⌘↵</kbd> save
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
    /* Scrim covers the kanban host. Click outside the card cancels. */
    .stash-scrim {
      position: absolute;
      inset: 0;
      background: rgba(46, 42, 38, 0.45);
      z-index: 200;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 60px 20px 20px;
      overflow: auto;
      animation: stash-scrim-in 120ms ease-out;
    }
    @keyframes stash-scrim-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .stash-card {
      width: 100%;
      max-width: 520px;
      background: #F4F0E8;
      border: 1px solid rgba(46, 42, 38, 0.18);
      border-radius: 4px;
      box-shadow: 0 12px 32px rgba(46, 42, 38, 0.22);
      font-family: var(--font-main, 'EB Garamond', serif);
      color: #2E2A26;
      display: flex;
      flex-direction: column;
      animation: stash-card-in 160ms ease-out;
    }
    @keyframes stash-card-in {
      from { transform: translateY(-6px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .stash-header {
      padding: 14px 18px 10px;
      border-bottom: 1px solid rgba(46, 42, 38, 0.10);
      background: #E5DED2;
      border-radius: 4px 4px 0 0;
    }
    .stash-title {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .stash-subtitle {
      font-style: italic;
      font-size: 13px;
      color: #7A7068;
      margin-top: 2px;
    }
    .stash-body {
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .stash-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .stash-label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #5C544D;
    }
    .stash-optional {
      font-weight: 400;
      text-transform: none;
      font-style: italic;
      color: #9A8E80;
      letter-spacing: 0;
    }
    .stash-input,
    .stash-textarea,
    .stash-tag-input {
      font-family: var(--font-main, 'EB Garamond', serif);
      font-size: 15px;
      color: #2E2A26;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      padding: 7px 9px;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .stash-textarea {
      resize: vertical;
      min-height: 96px;
      font-family: var(--font-main, 'EB Garamond', serif);
      line-height: 1.45;
    }
    .stash-input:focus,
    .stash-textarea:focus,
    .stash-tag-input:focus {
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
    /* Warn variant: surfaced live by validateParentSlug() for path-shaped or
       otherwise malformed parent slugs. Same size as the regular hint so the
       row doesn't jump on transition; just shifts to a warning hue. */
    .stash-hint-warn {
      color: #8C5A1A;
      font-style: normal;
    }
    .stash-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      background: #FFFFFF;
      border: 1px solid rgba(46, 42, 38, 0.20);
      border-radius: 3px;
      min-height: 36px;
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
    /* City picker — single-select combobox over availableCities. The input
       acts as both display and filter (readOnly collapses it to a button-
       like surface). The list is absolutely-positioned beneath the input,
       elevation matches the form card so it visually hovers over the
       fields below. Z-index 10 keeps it above sibling fields without
       fighting the scrim (z 200). */
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
      padding: 8px 10px;
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
    .stash-checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #4C453F;
    }
    .stash-checkbox-row input {
      cursor: pointer;
    }
    .stash-error {
      padding: 8px 10px;
      background: rgba(178, 78, 60, 0.12);
      border: 1px solid rgba(178, 78, 60, 0.5);
      color: #8B3A28;
      font-size: 13px;
      border-radius: 2px;
    }
    .stash-footer {
      padding: 10px 18px 14px;
      border-top: 1px solid rgba(46, 42, 38, 0.10);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: #EFEAE0;
      border-radius: 0 0 4px 4px;
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
      padding: 6px 14px;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 120ms ease-out, border-color 120ms ease-out;
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
