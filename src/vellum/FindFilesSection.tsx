/**
 * FindFilesSection — the cross-project Files column of the Find dashboard
 * (Stage E of constitution-portolan-navigation-layer).
 *
 * Renders a `react-arborist` virtualized tree, top-level entries grouped
 * by pinned local city. Each city expands to its root directory's
 * entries, which themselves expand on demand via the
 * `requestDirectoryListing` callback (WS `listDirectory` round-trip).
 *
 * Why split off from `FindHost.tsx`: the tree's lazy-loading state
 * machine, react-arborist wiring, and per-node renderer already runs
 * ~250 LOC; threading that through FindHost would push the file past
 * the readable threshold for the dashboard shell. Keeps each file
 * scoped to a single dashboard concern.
 *
 * Scope ladder:
 *   - city scope (cityId set)   → only the focused city expands by default
 *   - global scope (no cityId)  → all cities collapsed by default
 *
 * Click-through:
 *   - file row → `mountContext.openFile({ path, cityId })` opens vellum
 *     in file mode (the same surface a HUD file click already uses).
 *   - dir row → no click-through; toggle expand/collapse via the chevron.
 *
 * Constitution decision §"Vellum's navigation chrome carries the up/down
 * browse" applies: the Find tree shows top-level + one expand level for
 * shallow browse; deeper exploration hands off to vellum's per-file
 * chrome (back/forward, breadcrumb). The constitution is comfortable
 * with the tree going deeper than two levels — react-arborist makes
 * deep nesting cheap — but the implementation keeps the lazy-load API
 * the same shape for any depth so a future amendment can flip
 * shallow/deep without rewiring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tree, type NodeApi, type NodeRendererProps } from 'react-arborist'
import { getPortolanMountContext } from './mount'

// ---------------------------------------------------------------------------
// Tree shape
// ---------------------------------------------------------------------------

interface FileTreeNode {
  /** Unique-across-tree id. `${cityId}` for a city; `${cityId}::${path}`
   *  for a directory or file underneath. arborist needs uniqueness so we
   *  scope by city even when two projects share the same relative layout. */
  id: string
  name: string
  /** `city` is the synthesized top-level grouping; `dir` and `file` come
   *  from the directoryListing protocol. `loading` and `error` are
   *  rendered as leaf placeholders inside an opened-but-not-yet-loaded
   *  directory so the user sees feedback. */
  kind: 'city' | 'dir' | 'file' | 'loading' | 'error'
  cityId: string
  /** Full filesystem path. Empty for the city-row pseudo-node (the city's
   *  path is folded into the children's paths below it). */
  fullPath: string
  /** Children are `undefined` = not yet loaded, `[]` = loaded with no
   *  entries, `[…]` = loaded with entries. arborist's `childrenAccessor`
   *  returns null for files (leaves) and the array (or `[]`) for
   *  directories (so the disclosure caret renders even when unloaded). */
  children?: FileTreeNode[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FindFilesSectionProps {
  /** Focused city — when set, expands its city node and pre-loads the
   *  root directory listing on first mount. */
  cityId?: string
  /** Cities the dashboard knows about. We only show pinned local cities
   *  in the Files column today (remote-files is out of scope). The
   *  parent (FindHost) reads them off `mountContext.getCities()`; passing
   *  in keeps re-renders here predictable when the city list updates. */
  cities: Array<{ id: string; name?: string; path: string; originId: string }>
}

export function FindFilesSection({
  cityId,
  cities,
}: FindFilesSectionProps): JSX.Element {
  const ctx = getPortolanMountContext()
  const requestListing = ctx?.requestDirectoryListing
  const openFile = ctx?.openFile

  // Stage E only walks pinned local cities. Remote-files search is
  // explicitly deferred to a follow-up — see the constitution's Scope
  // §"Out" and the FilesSearch.ts header comment.
  const localCities = useMemo(
    () => cities.filter((c) => c.originId === 'local'),
    [cities],
  )

  // Tree data: array of city nodes. Children are loaded lazily; the
  // focused city's root is pre-loaded on first mount. Keyed by city id +
  // path so the entire tree can be rebuilt as an immutable structure on
  // each load (arborist diffs by id, not reference, so this stays
  // efficient).
  const [data, setData] = useState<FileTreeNode[]>(() =>
    localCities.map((c) => makeCityNode(c)),
  )

  // Re-seed when cities change (e.g. a new pin). Preserves any loaded
  // children for cities still in the list — without this, a transient
  // refetch would collapse the tree on every state-sync push.
  useEffect(() => {
    setData((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      return localCities.map((c) => byId.get(c.id) ?? makeCityNode(c))
    })
  }, [localCities])

  // Track which node ids are currently loading so racing toggles don't
  // fire duplicate WS requests. The DirectoryListingClient already
  // coalesces by `(cityId, path)` on the wire, but we still want to gate
  // on the node-id level to keep the placeholder rendering stable across
  // the React-tree state.
  const loadingIds = useRef(new Set<string>())

  /**
   * Load a directory's children and patch the tree. Idempotent: a second
   * call for a node already-loaded or in-flight returns immediately.
   *
   * `targetId` is the tree-node id we patch (city nodes use the bare
   * `cityId`; directory nodes underneath use `${cityId}::${fullPath}`).
   * Keeping it explicit here avoids the city-vs-dir id mismatch a single
   * "always derive from cityId+path" approach would have introduced.
   */
  const loadDirectory = useCallback(
    async (targetId: string, cityId: string, fullPath: string): Promise<void> => {
      if (loadingIds.current.has(targetId)) return
      loadingIds.current.add(targetId)

      // Show a loading placeholder under the node while the WS round-trip
      // resolves. The user sees "Loading…" instead of an empty body, which
      // matters more on remote-mounted hosts where the listing can take
      // several hundred ms.
      setData((prev) => patchNode(prev, targetId, () => ({
        children: [makePlaceholder(cityId, targetId, 'loading')],
      })))

      if (!requestListing) {
        setData((prev) => patchNode(prev, targetId, () => ({
          children: [makePlaceholder(cityId, targetId, 'error', 'Mount context not ready')],
        })))
        loadingIds.current.delete(targetId)
        return
      }

      const result = await requestListing(cityId, fullPath)
      loadingIds.current.delete(targetId)

      if (result.error) {
        setData((prev) => patchNode(prev, targetId, () => ({
          children: [makePlaceholder(cityId, targetId, 'error', result.error)],
        })))
        return
      }

      const children: FileTreeNode[] = result.entries.map((entry) => {
        const childPath = joinPath(fullPath, entry.name)
        return {
          id: nodeIdOf(cityId, childPath),
          name: entry.name,
          kind: entry.type === 'dir' ? 'dir' : 'file',
          cityId,
          fullPath: childPath,
        }
      })

      setData((prev) => patchNode(prev, targetId, () => ({ children })))
    },
    [requestListing],
  )

  // First-mount preload for the focused city's root, so the user lands on
  // something usable. Skipped in global scope (constitution: trees show
  // "focused-city expanded" — without one, the tree stays collapsed).
  const preloadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!cityId) return
    if (preloadedRef.current === cityId) return
    const city = localCities.find((c) => c.id === cityId)
    if (!city) return
    preloadedRef.current = cityId
    // City node id is `cityId` (see makeCityNode); pass it through so
    // patchNode hits the right top-level row.
    void loadDirectory(cityId, cityId, city.path)
  }, [cityId, localCities, loadDirectory])

  // Initially-open: focused city only. Keyed map per arborist's
  // `initialOpenState` shape: `{ [id]: boolean }`. Once the user toggles,
  // arborist owns the open state.
  const initialOpenState = useMemo(() => {
    if (!cityId) return {}
    return { [cityId]: true }
  }, [cityId])

  /** arborist `onToggle`: trigger lazy-load for unloaded directories. */
  const handleToggle = useCallback(
    (id: string) => {
      // Lookup the node by id by walking the tree once. The tree is
      // typically <= 200 visible nodes; a linear walk is fine and avoids
      // an index that has to stay in sync with patchNode.
      const node = findNode(data, id)
      if (!node) return
      // Already loaded (or city without a known path) — nothing to do.
      if (node.kind === 'file') return
      if (node.kind === 'city') {
        const city = localCities.find((c) => c.id === node.cityId)
        if (!city) return
        if (node.children !== undefined) return
        // City row's tree-id is `cityId` directly; pass it as the patch
        // target so the response lands on this node, not a path-keyed
        // sibling that doesn't exist.
        void loadDirectory(node.id, node.cityId, city.path)
        return
      }
      if (node.kind === 'dir' && node.children === undefined) {
        void loadDirectory(node.id, node.cityId, node.fullPath)
      }
    },
    [data, localCities, loadDirectory],
  )

  /** Click-through for files. Dir clicks are toggle-only; arborist's
   *  default Tree handles that — `onActivate` only fires on selection. */
  const handleActivate = useCallback(
    (node: NodeApi<FileTreeNode>) => {
      if (node.data.kind !== 'file') return
      if (!openFile) {
        console.warn('[FindFilesSection] openFile not wired; click ignored.')
        return
      }
      openFile({
        path: node.data.fullPath,
        cityId: node.data.cityId,
        originId: 'local',
      })
    },
    [openFile],
  )

  // Empty state: no pinned local cities. Constitution Scope §"Out"
  // explicitly defers remote-files; this is the honest empty.
  if (localCities.length === 0) {
    return (
      <div
        style={{
          fontSize: '0.85rem',
          opacity: 0.7,
          padding: '0.5rem 0.25rem',
        }}
      >
        No pinned local cities.
      </div>
    )
  }

  return (
    <div className="find-files-tree">
      <Tree<FileTreeNode>
        data={data}
        idAccessor="id"
        childrenAccessor={(d) => (d.kind === 'file' ? null : d.children ?? [])}
        openByDefault={false}
        initialOpenState={initialOpenState}
        onToggle={handleToggle}
        onActivate={handleActivate}
        rowHeight={22}
        // The container has its own height; arborist needs an explicit
        // numeric height. Using a tall-but-finite value (28rem) keeps the
        // virtualization on without requiring a ResizeObserver-based
        // wrapper for every Find re-layout. The dashboard's grid-row
        // height already constrains the visible area; this is the
        // virtualization budget, not the visible height.
        height={448}
        width="100%"
        indent={14}
        disableMultiSelection
        disableDrag
        disableEdit
        disableDrop
      >
        {FileTreeRow}
      </Tree>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row renderer
// ---------------------------------------------------------------------------

/**
 * One tree row. arborist supplies positioning via `style` (left padding +
 * vertical placement); we add the chevron, kind glyph, and label. The
 * row's click target is the whole row so files open on click and dirs
 * toggle on click — matches the HUD file tree's affordance.
 */
function FileTreeRow({
  node,
  style,
  dragHandle,
}: NodeRendererProps<FileTreeNode>): JSX.Element {
  const data = node.data

  // Placeholders (loading / error) render dimmer and don't carry the
  // click-to-toggle affordance — they're informational rows under an
  // already-opened parent.
  if (data.kind === 'loading' || data.kind === 'error') {
    return (
      <div
        ref={dragHandle}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          paddingLeft: `${(node.level + 1) * 14 + 8}px`,
          fontSize: '0.78rem',
          color:
            data.kind === 'error'
              ? 'var(--text-error, #B5402F)'
              : 'var(--text-muted, #7A7368)',
          fontStyle: 'italic',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        aria-disabled="true"
      >
        {data.name}
      </div>
    )
  }

  const isDir = data.kind === 'dir' || data.kind === 'city'
  const onRowClick = (): void => {
    if (isDir) {
      node.toggle()
    } else {
      node.activate()
    }
  }

  return (
    <button
      ref={dragHandle as unknown as React.Ref<HTMLButtonElement>}
      type="button"
      onClick={onRowClick}
      title={data.fullPath || data.name}
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0 0.4rem',
        paddingLeft: `${node.level * 14 + 8}px`,
        background: node.isSelected
          ? 'var(--surface-hover, rgba(0,0,0,0.06))'
          : 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
      className="find-fiber-row"
      aria-expanded={isDir ? node.isOpen : undefined}
      aria-label={
        isDir
          ? `${data.name} (${node.isOpen ? 'expanded ' : ''}directory)`
          : `${data.name} (file)`
      }
    >
      <span
        aria-hidden="true"
        style={{
          width: '0.85rem',
          fontSize: '0.65rem',
          opacity: 0.6,
          flexShrink: 0,
        }}
      >
        {isDir ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      {data.kind === 'city' && (
        <span
          aria-hidden="true"
          style={{
            fontSize: '0.7rem',
            color: 'var(--accent, #8A5A2B)',
            opacity: 0.7,
            flexShrink: 0,
          }}
        >
          ⬢
        </span>
      )}
      <span
        style={{
          fontSize: '0.85rem',
          fontWeight: data.kind === 'city' ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {data.name}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCityNode(city: {
  id: string
  name?: string
  path: string
}): FileTreeNode {
  return {
    id: city.id,
    name: city.name ?? city.path.split('/').pop() ?? city.id,
    kind: 'city',
    cityId: city.id,
    fullPath: city.path,
    // children stay undefined — first toggle / preload kicks off the
    // listing and patches the node with [] or [...].
  }
}

function makePlaceholder(
  cityId: string,
  parentId: string,
  kind: 'loading' | 'error',
  message?: string,
): FileTreeNode {
  return {
    id: `${parentId}::__${kind}`,
    name:
      kind === 'loading'
        ? 'Loading…'
        : `Couldn't read directory${message ? `: ${message}` : ''}`,
    kind,
    cityId,
    fullPath: '',
  }
}

function nodeIdOf(cityId: string, fullPath: string): string {
  return `${cityId}::${fullPath}`
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith('/')) return parent + name
  return `${parent}/${name}`
}

/**
 * Replace a node in the tree, returning a new tree array. Used by the
 * directory-load completion path; the patch function returns the partial
 * fields to merge onto the matched node. Stable across siblings to keep
 * arborist's id-based diff minimal.
 */
function patchNode(
  nodes: FileTreeNode[],
  targetId: string,
  patch: (current: FileTreeNode) => Partial<FileTreeNode>,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.id === targetId) {
      return { ...node, ...patch(node) }
    }
    if (node.children && node.children.length > 0) {
      const nextChildren = patchNode(node.children, targetId, patch)
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren }
      }
    }
    return node
  })
}

function findNode(
  nodes: FileTreeNode[],
  id: string,
): FileTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) {
      const hit = findNode(n.children, id)
      if (hit) return hit
    }
  }
  return null
}
