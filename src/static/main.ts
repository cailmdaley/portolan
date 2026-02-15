import { TapestryView } from '../ui/TapestryView'
import type { TapestryResponse } from '../ui/TapestryView'

const view = new TapestryView()

fetch('./data/tapestry.json')
  .then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    return r.json()
  })
  .then((data: TapestryResponse) => {
    view.showStatic(data, 'pure-eb')
  })
  .catch(err => {
    console.error('Failed to load tapestry data:', err)
    // Show error visibly — the TapestryView panel is still opacity:0
    view.showStatic(
      { nodes: [], links: [], downstream: {}, config: null },
      'pure-eb',
    )
    const dag = document.querySelector('.tapestry-dag')
    if (dag) {
      dag.innerHTML = `<div style="
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        font-family: var(--font-main); color: var(--ui-text-muted); text-align: center;
        line-height: 1.8; font-size: 0.95rem;
      ">
        <div style="font-size: 1.2rem; margin-bottom: 0.5rem;">No tapestry data found</div>
        <div style="font-size: 0.8rem;">
          Run <code style="font-family: var(--font-mono); background: var(--ui-dark-surface);
          padding: 0.15rem 0.4rem; border-radius: 2px;">npm run export:tapestry -- pure-eb</code>
          then rebuild.
        </div>
      </div>`
    }
  })
