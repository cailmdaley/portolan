import { Group, Vector3 } from 'three'
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

interface LabelDragState {
  workerId: string
  startX: number
  startY: number
  moved: boolean
  labelEl: HTMLElement
}

interface LabelInteractionStats {
  active: boolean
  listenersAttached: boolean
  resetTimeoutPending: boolean
}

export interface ZoneRendererSwarmHandle {
  group: Group
  userOffset: Vector3
  getLabel(): CSS2DObject | null
}

export class ZoneRendererLabelInteractions {
  private readonly getSwarm: (workerId: string) => ZoneRendererSwarmHandle | undefined
  private onWorkerClick: ((workerId: string, tmuxSession: string) => void) | null = null
  private onWorkerDblClick: ((workerId: string, tmuxSession: string) => void) | null = null
  private onWorkerLabelHover: ((workerId: string, tmuxSession: string, anchor: { x: number; y: number }) => void) | null = null
  private onWorkerLabelHoverEnd: (() => void) | null = null
  private onWorkerContextMenu: ((workerId: string, tmuxSession: string, clientX: number, clientY: number) => void) | null = null
  private onCityLabelClick: ((cityId: string) => void) | null = null
  private screenToWorldConverter: ((x: number, y: number) => { x: number; z: number }) | null = null
  private labelDrag: LabelDragState | null = null
  private labelDragListenersAttached = false
  private labelDragResetTimeoutId: number | null = null

  constructor(getSwarm: (workerId: string) => ZoneRendererSwarmHandle | undefined) {
    this.getSwarm = getSwarm
  }

  setWorkerClickHandler(onClick: (workerId: string, tmuxSession: string) => void): void {
    this.onWorkerClick = onClick
  }

  setWorkerDblClickHandler(onDblClick: (workerId: string, tmuxSession: string) => void): void {
    this.onWorkerDblClick = onDblClick
  }

  setWorkerLabelHoverHandlers(
    onHover: (workerId: string, tmuxSession: string, anchor: { x: number; y: number }) => void,
    onHoverEnd: () => void
  ): void {
    this.onWorkerLabelHover = onHover
    this.onWorkerLabelHoverEnd = onHoverEnd
  }

  setWorkerContextMenuHandler(
    onContextMenu: (workerId: string, tmuxSession: string, clientX: number, clientY: number) => void,
  ): void {
    this.onWorkerContextMenu = onContextMenu
  }

  setCityLabelClickHandler(onClick: (cityId: string) => void): void {
    this.onCityLabelClick = onClick
  }

  setScreenToWorldConverter(converter: (x: number, y: number) => { x: number; z: number }): void {
    this.screenToWorldConverter = converter
  }

  bindWorkerLabel(labelEl: HTMLElement, workerId: string, tmuxSession: string): void {
    this.setupLabelDrag(labelEl, workerId)
    this.setupLabelClickHandlers(labelEl, workerId, tmuxSession)
  }

  bindCityLabel(labelEl: HTMLElement, cityId: string): void {
    labelEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onCityLabelClick?.(cityId)
    })
  }

  startSwarmDrag(workerId: string, screenX: number, screenY: number): boolean {
    const swarm = this.getSwarm(workerId)
    if (!swarm) return false

    const labelEl = swarm.getLabel()?.element as HTMLElement | undefined
    this.cancelActiveLabelDrag()

    this.labelDrag = {
      workerId,
      startX: screenX,
      startY: screenY,
      moved: false,
      labelEl: labelEl || document.createElement('div'),
    }

    const birdCursor = 'var(--cursor-bird)'
    document.body.style.cursor = birdCursor
    if (labelEl) labelEl.style.cursor = birdCursor

    this.attachLabelDragListeners()
    return true
  }

  get isDraggingSwarm(): boolean {
    return this.labelDrag !== null && this.labelDrag.moved
  }

  getRuntimeStats(): LabelInteractionStats {
    return {
      active: this.labelDrag !== null,
      listenersAttached: this.labelDragListenersAttached,
      resetTimeoutPending: this.labelDragResetTimeoutId !== null,
    }
  }

  dispose(): void {
    this.cancelActiveLabelDrag()
    this.onWorkerClick = null
    this.onWorkerDblClick = null
    this.onWorkerLabelHover = null
    this.onWorkerLabelHoverEnd = null
    this.onCityLabelClick = null
    this.screenToWorldConverter = null
  }

  private setupLabelDrag(labelEl: HTMLElement, workerId: string): void {
    labelEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.cancelActiveLabelDrag()

      this.labelDrag = {
        workerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        labelEl,
      }

      const birdCursor = 'var(--cursor-bird)'
      labelEl.style.cursor = birdCursor
      document.body.style.cursor = birdCursor

      this.attachLabelDragListeners()
    })
  }

  private setupLabelClickHandlers(labelEl: HTMLElement, workerId: string, tmuxSession: string): void {
    labelEl.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.labelDrag?.workerId === workerId && this.labelDrag.moved) {
        return
      }
      this.onWorkerClick?.(workerId, tmuxSession)
    })
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.onWorkerDblClick?.(workerId, tmuxSession)
    })
    labelEl.addEventListener('contextmenu', (e) => {
      if (!this.onWorkerContextMenu) return
      e.preventDefault()
      e.stopPropagation()
      this.onWorkerContextMenu(workerId, tmuxSession, e.clientX, e.clientY)
    })
    labelEl.addEventListener('mouseenter', () => {
      if (!this.onWorkerLabelHover) return
      const rect = labelEl.getBoundingClientRect()
      this.onWorkerLabelHover(workerId, tmuxSession, { x: rect.left + rect.width / 2, y: rect.top })
    })
    labelEl.addEventListener('mouseleave', () => {
      this.onWorkerLabelHoverEnd?.()
    })
  }

  private onLabelDrag = (e: MouseEvent): void => {
    if (!this.labelDrag) return

    const dx = e.clientX - this.labelDrag.startX
    const dy = e.clientY - this.labelDrag.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this.labelDrag.moved = true
    }

    if (!this.labelDrag.moved || !this.screenToWorldConverter) return

    const worldStart = this.screenToWorldConverter(this.labelDrag.startX, this.labelDrag.startY)
    const worldNow = this.screenToWorldConverter(e.clientX, e.clientY)
    const worldDx = worldNow.x - worldStart.x
    const worldDz = worldNow.z - worldStart.z

    this.labelDrag.startX = e.clientX
    this.labelDrag.startY = e.clientY

    const swarm = this.getSwarm(this.labelDrag.workerId)
    if (!swarm) return
    swarm.userOffset.x += worldDx
    swarm.userOffset.z += worldDz
    swarm.group.position.x += worldDx
    swarm.group.position.z += worldDz
  }

  private clearLabelDragResetTimeout(): void {
    if (this.labelDragResetTimeoutId === null) return
    window.clearTimeout(this.labelDragResetTimeoutId)
    this.labelDragResetTimeoutId = null
  }

  private attachLabelDragListeners(): void {
    if (this.labelDragListenersAttached) return
    document.addEventListener('mousemove', this.onLabelDrag)
    document.addEventListener('mouseup', this.stopLabelDrag)
    this.labelDragListenersAttached = true
  }

  private detachLabelDragListeners(): void {
    if (!this.labelDragListenersAttached) return
    document.removeEventListener('mousemove', this.onLabelDrag)
    document.removeEventListener('mouseup', this.stopLabelDrag)
    this.labelDragListenersAttached = false
  }

  private cancelActiveLabelDrag(): void {
    this.clearLabelDragResetTimeout()
    if (this.labelDrag?.labelEl) {
      this.labelDrag.labelEl.style.cursor = 'grab'
    }
    this.labelDrag = null
    document.body.style.cursor = ''
    this.detachLabelDragListeners()
  }

  private stopLabelDrag = (): void => {
    if (!this.labelDrag) {
      this.detachLabelDragListeners()
      document.body.style.cursor = ''
      return
    }

    this.labelDrag.labelEl.style.cursor = 'grab'
    document.body.style.cursor = ''
    this.detachLabelDragListeners()
    this.clearLabelDragResetTimeout()

    const drag = this.labelDrag
    this.labelDragResetTimeoutId = window.setTimeout(() => {
      if (this.labelDrag === drag) {
        this.labelDrag = null
      }
      this.labelDragResetTimeoutId = null
    }, 10)
  }
}
