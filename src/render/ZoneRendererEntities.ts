import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Shape,
  Vector3,
} from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Texture } from 'three'
import { HexGrid } from './HexGrid'
import { CitySpritesManager } from './CitySpritesManager'
import { WorkerSwarm } from './WorkerSwarm'
import { ZoneRendererLabelInteractions } from './ZoneRendererLabelInteractions'
import type { City, HexCoord, Session } from '../state/types'
import { PALETTE } from '../state/types'

export interface ZoneRendererActivity {
  tool: string
  summary?: string
  timestamp: number
}

interface HexMeshData {
  group: Group
  hex: HexCoord
  type: 'city' | 'worker' | 'empty'
  entityId?: string
  entityName?: string
  originId?: string
  tmuxSession?: string
  activitySessionKey?: string
  status?: 'idle' | 'working'
  activityMesh?: Mesh
  labelObject?: CSS2DObject
  workerLabels?: CSS2DObject[]
  cityName?: string
  workerCount?: number
}

export class ZoneRendererEntities {
  private readonly scene: Group | Object3D
  private readonly hexGrid: HexGrid
  private readonly citySprites: CitySpritesManager
  private readonly labelInteractions: ZoneRendererLabelInteractions
  private readonly hexHeight: number
  private readonly cameraRotation: number
  private readonly hexMeshes: Map<string, HexMeshData> = new Map()
  private readonly workerSwarms: Map<string, WorkerSwarm> = new Map()

  constructor(
    scene: Group | Object3D,
    hexGrid: HexGrid,
    citySprites: CitySpritesManager,
    labelInteractions: ZoneRendererLabelInteractions,
    hexHeight: number,
    cameraRotation: number
  ) {
    this.scene = scene
    this.hexGrid = hexGrid
    this.citySprites = citySprites
    this.labelInteractions = labelInteractions
    this.hexHeight = hexHeight
    this.cameraRotation = cameraRotation
  }

  get hexMeshCount(): number {
    return this.hexMeshes.size
  }

  get workerSwarmCount(): number {
    return this.workerSwarms.size
  }

  getSwarm(workerId: string): WorkerSwarm | undefined {
    return this.workerSwarms.get(workerId)
  }

  getEntityAtHex(hex: HexCoord): { type: 'city' | 'worker' | 'empty'; entityId?: string; entityName?: string } | null {
    const key = this.hexGrid.hexKey(hex)
    const data = this.hexMeshes.get(key)
    if (!data) return null
    return { type: data.type, entityId: data.entityId, entityName: data.entityName }
  }

  getCityAtWorldPos(worldX: number, worldZ: number): { entityId: string } | null {
    const spriteRadius = 3.25
    let nearest: { entityId: string; dist: number } | null = null

    for (const [, data] of this.hexMeshes) {
      if (data.type !== 'city' || !data.entityId) continue
      const pos = this.hexGrid.axialToCartesian(data.hex)
      const dist = Math.sqrt((pos.x - worldX) ** 2 + (pos.z - worldZ) ** 2)
      if (dist <= spriteRadius && (!nearest || dist < nearest.dist)) {
        nearest = { entityId: data.entityId, dist }
      }
    }

    return nearest ? { entityId: nearest.entityId } : null
  }

  getWorkerAtWorldPos(worldX: number, worldZ: number): { workerId: string; tmuxSession: string } | null {
    let nearestDist = Infinity
    let nearestWorker: { workerId: string; tmuxSession: string } | null = null

    for (const [, data] of this.hexMeshes) {
      if (data.type !== 'city') continue
      const cityPos = this.hexGrid.axialToCartesian(data.hex)
      data.group.traverse((child) => {
        if (!child.userData?.workerId) return
        const swarmWorldX = cityPos.x + child.position.x
        const swarmWorldZ = cityPos.z + child.position.z
        const dist = Math.sqrt((swarmWorldX - worldX) ** 2 + (swarmWorldZ - worldZ) ** 2)
        if (dist <= 0.8 && dist < nearestDist) {
          nearestDist = dist
          nearestWorker = {
            workerId: child.userData.workerId as string,
            tmuxSession: child.userData.tmuxSession as string,
          }
        }
      })
    }

    return nearestWorker
  }

  getSwarmWorldPosition(workerId: string): { x: number; z: number } | null {
    const swarm = this.workerSwarms.get(workerId)
    if (!swarm) return null
    swarm.group.updateWorldMatrix(true, false)
    const pos = new Vector3()
    swarm.group.getWorldPosition(pos)
    return { x: pos.x, z: pos.z }
  }

  renderCity(city: City, workers: Session[] = [], nameIsAmbiguous = false): void {
    const key = this.hexGrid.hexKey(city.hex)
    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(city.hex)
    this.addCityHexGrid(group, city.hex)

    const texture = this.citySprites.getSprite(city)
    if (texture) {
      group.add(this.createCitySpriteMesh(texture))
    } else {
      group.add(this.createHexMesh(PALETTE.cityHex, 0.3, 0.05))
    }

    const labelDiv = document.createElement('div')
    labelDiv.className = 'city-label'
    labelDiv.textContent = city.name
    // Disambiguate two cities sharing a name by appending their origin
    // (e.g. a local `ai-futures` and a `remote-cineca/ai-futures` project).
    // `local` is elided — it's the default and doesn't need a label.
    if (nameIsAmbiguous && city.originId !== 'local') {
      const hostLabel = city.originId.replace(/^remote-/, '')
      const originSpan = document.createElement('span')
      originSpan.className = 'city-label-origin'
      originSpan.textContent = hostLabel
      labelDiv.appendChild(originSpan)
    }
    labelDiv.style.cursor = 'pointer'
    this.labelInteractions.bindCityLabel(labelDiv, city.id)

    const labelObject = new CSS2DObject(labelDiv)
    labelObject.position.set(0, 1.5, 0)
    group.add(labelObject)

    const workerLabels: CSS2DObject[] = []
    const swarmRadius = 3.0
    const arcStart = -Math.PI * 0.75
    const arcEnd = -Math.PI * 0.25

    workers.forEach((worker, i) => {
      const arcSpan = arcEnd - arcStart
      const angle = workers.length === 1
        ? -Math.PI * 0.5
        : arcStart + (arcSpan * i / (workers.length - 1))

      const swarm = this.getOrCreateSwarm(worker.id, worker.tmuxSession)
      swarm.group.position.set(
        Math.cos(angle) * swarmRadius + swarm.userOffset.x,
        0,
        Math.sin(angle) * swarmRadius + swarm.userOffset.z
      )
      swarm.setActivity(worker.status === 'working' ? 1 : 0)
      group.add(swarm.group)

      const workerDiv = document.createElement('div')
      workerDiv.className = this.workerLabelClass(worker.status)
      workerDiv.textContent = worker.name
      workerDiv.dataset.workerId = worker.id
      workerDiv.dataset.tmuxSession = worker.tmuxSession
      workerDiv.style.cursor = 'grab'
      this.labelInteractions.bindWorkerLabel(workerDiv, worker.id, worker.tmuxSession)

      const workerLabelObj = new CSS2DObject(workerDiv)
      swarm.setLabel(workerLabelObj)
      workerLabels.push(workerLabelObj)
    })

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)
    this.hexMeshes.set(key, {
      group,
      hex: city.hex,
      type: 'city',
      entityId: city.id,
      labelObject,
      workerLabels,
      cityName: city.name,
      workerCount: workers.length,
    })
  }

  renderOrphanWorker(session: Session, activitySessionKey: string): void {
    if (!session.hex) return
    const key = this.hexGrid.hexKey(session.hex)
    const existing = this.hexMeshes.get(key)

    if (existing && existing.type === 'worker' && existing.entityId === session.id) {
      if (existing.status !== session.status) {
        if (existing.labelObject) {
          existing.labelObject.element.className = this.workerLabelClass(session.status)
        }
        this.workerSwarms.get(session.id)?.setActivity(session.status === 'working' ? 1 : 0)
        existing.status = session.status
      }
      return
    }

    this.removeHex(key)

    const group = new Group()
    const pos = this.hexGrid.axialToCartesian(session.hex)
    const swarm = this.getOrCreateSwarm(session.id, session.tmuxSession)
    swarm.group.position.set(swarm.userOffset.x, 0, swarm.userOffset.z)
    swarm.setActivity(session.status === 'working' ? 1 : 0)
    group.add(swarm.group)

    const labelDiv = document.createElement('div')
    labelDiv.className = this.workerLabelClass(session.status)
    labelDiv.textContent = session.name
    labelDiv.dataset.workerId = session.id
    labelDiv.dataset.tmuxSession = session.tmuxSession
    labelDiv.style.cursor = 'move'
    this.labelInteractions.bindWorkerLabel(labelDiv, session.id, session.tmuxSession)

    const labelObject = new CSS2DObject(labelDiv)
    labelObject.position.y = 0.6
    group.add(labelObject)

    group.position.set(pos.x, 0, pos.z)
    this.scene.add(group)
    this.hexMeshes.set(key, {
      group,
      hex: session.hex,
      type: 'worker',
      entityId: session.id,
      entityName: session.name,
      originId: session.originId,
      tmuxSession: session.tmuxSession,
      activitySessionKey,
      status: session.status,
      labelObject,
    })
  }

  removeUnexpectedHexes(expectedKeys: Set<string>): void {
    for (const [key, data] of this.hexMeshes) {
      if (!expectedKeys.has(key) && data.type !== 'empty') {
        this.removeHex(key)
      }
    }
  }

  clearMissingWorkers(currentWorkerIds: Set<string>): void {
    for (const workerId of this.workerSwarms.keys()) {
      if (!currentWorkerIds.has(workerId)) {
        const swarm = this.workerSwarms.get(workerId)
        if (!swarm) continue
        swarm.dispose()
        this.workerSwarms.delete(workerId)
      }
    }
  }

  updateLabelFontSizes(cityFontSize: number, workerFontSize: number): void {
    for (const [, data] of this.hexMeshes) {
      if (data.type !== 'city') continue
      if (data.labelObject) {
        const label = data.labelObject.element as HTMLElement
        label.style.fontSize = `${cityFontSize}px`
      }
      data.workerLabels?.forEach((workerLabel) => {
        const el = workerLabel.element as HTMLElement
        el.style.fontSize = `${workerFontSize}px`
      })
    }
  }

  updateSwarmAnimation(deltaTime: number, cameraDistance?: number): void {
    for (const swarm of this.workerSwarms.values()) {
      if (cameraDistance !== undefined) {
        swarm.setCameraDistance(cameraDistance)
      }
      swarm.update(deltaTime)
    }
  }

  updateWorkerActivity(activitySessionKey: string, activities: ZoneRendererActivity[]): void {
    const workerData = Array.from(this.hexMeshes.values()).find(
      (data) => data.type === 'worker' && data.activitySessionKey === activitySessionKey
    )
    if (!workerData) return
    const existingMesh = workerData.activityMesh
    if (!existingMesh) return

    this.disposeObject(existingMesh)
    workerData.group.remove(existingMesh)

    const newMesh = this.createActivityDecal(activities)
    newMesh.position.y = this.hexHeight + 0.08
    const activityOffset = this.hexToWorld(-0.023, -0.03)
    newMesh.position.x = activityOffset.x
    newMesh.position.z = activityOffset.z
    workerData.group.add(newMesh)
    workerData.activityMesh = newMesh
  }

  dispose(): void {
    for (const key of this.hexMeshes.keys()) {
      this.removeHex(key)
    }
    for (const swarm of this.workerSwarms.values()) {
      swarm.dispose()
    }
    this.workerSwarms.clear()
  }

  private workerLabelClass(status: 'idle' | 'working'): string {
    return status === 'working' ? 'worker-label working' : 'worker-label'
  }

  private getOrCreateSwarm(workerId: string, tmuxSession: string): WorkerSwarm {
    const existing = this.workerSwarms.get(workerId)
    if (existing) return existing
    const swarm = new WorkerSwarm(workerId, tmuxSession)
    this.workerSwarms.set(workerId, swarm)
    return swarm
  }

  private createCitySpriteMesh(texture: Texture): Mesh {
    const spriteSize = 6.5
    const geometry = new PlaneGeometry(spriteSize, spriteSize)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })
    const cityMesh = new Mesh(geometry, material)
    cityMesh.rotation.x = -Math.PI / 2
    cityMesh.position.y = 0.02
    return cityMesh
  }

  private createHexShape(scale = 1): Shape {
    const r = this.hexGrid.hexRadius * scale
    const shape = new Shape()
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      const x = r * Math.cos(angle)
      const y = r * Math.sin(angle)
      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()
    return shape
  }

  private createHexMesh(color: number, scale = 1, height = this.hexHeight): Mesh {
    const shape = this.createHexShape(scale)
    const geometry = new ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    })
    const material = new MeshStandardMaterial({
      color,
      roughness: 0.8,
      metalness: 0.1,
    })
    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  private createHexEdge(scale = 1, opacity = 0.15): LineLoop {
    const r = this.hexGrid.hexRadius * scale
    const points: Vector3[] = []
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      points.push(new Vector3(r * Math.cos(angle), 0, r * Math.sin(angle)))
    }
    const geometry = new BufferGeometry().setFromPoints(points)
    const material = new LineBasicMaterial({
      color: PALETTE.gridEdge,
      transparent: true,
      opacity,
    })
    return new LineLoop(geometry, material)
  }

  private addCityHexGrid(group: Group, centerHex: HexCoord): void {
    const hexes = this.hexGrid.getHexesInRadius(centerHex, 4)
    for (const hex of hexes) {
      const relPos = this.hexGrid.axialToCartesian(hex)
      const centerPos = this.hexGrid.axialToCartesian(centerHex)
      const edge = this.createHexEdge(0.98, 0.10)
      edge.position.set(relPos.x - centerPos.x, 0.05, relPos.z - centerPos.z)
      group.add(edge)
    }
  }

  private removeHex(key: string): void {
    const data = this.hexMeshes.get(key)
    if (!data) return

    data.labelObject?.element.remove()
    data.workerLabels?.forEach((label) => label.element.remove())

    const swarmsToPreserve: Group[] = []
    data.group.traverse((child) => {
      if (child.userData?.workerId && child.parent === data.group) {
        swarmsToPreserve.push(child as Group)
      }
    })
    for (const swarmGroup of swarmsToPreserve) {
      data.group.remove(swarmGroup)
    }

    this.disposeObject(data.group)
    this.scene.remove(data.group)
    this.hexMeshes.delete(key)
  }

  private disposeObject(obj: Object3D): void {
    obj.traverse((child) => {
      if ('geometry' in child && child.geometry) {
        (child.geometry as BufferGeometry).dispose()
      }
      if ('material' in child && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const material of materials) {
          material.dispose()
          const basicMaterial = material as MeshBasicMaterial
          if (basicMaterial.map && !basicMaterial.map.userData?.managed) {
            basicMaterial.map.dispose()
          }
        }
      }
    })
  }

  private hexToWorld(hexX: number, hexY: number): { x: number; z: number } {
    const angle = this.cameraRotation + Math.PI / 3
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return {
      x: hexX * cos - hexY * sin,
      z: -hexX * sin - hexY * cos,
    }
  }

  private createActivityDecal(activities: ZoneRendererActivity[]): Mesh {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const width = 256
    const height = 144
    const fontSize = 13

    canvas.width = width * 2
    canvas.height = height * 2
    ctx.scale(2, 2)

    ctx.fillStyle = 'rgba(26, 24, 22, 0.7)'
    ctx.roundRect(0, 0, width, height, 4)
    ctx.fill()

    if (activities.length > 0) {
      const displayActivities = activities.slice(0, 3)
      const lineHeight = 24
      const startY = 18
      const centerX = width / 2

      displayActivities.forEach((activity, i) => {
        const y = startY + i * lineHeight
        const opacity = 1 - i * 0.25
        let text = activity.tool
        if (activity.summary) {
          const summaryText = activity.summary.length > 18
            ? `${activity.summary.slice(0, 15)}...`
            : activity.summary
          text += ` ${summaryText}`
        }
        ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = `rgba(201, 162, 39, ${opacity})`
        ctx.fillText(text, centerX, y)
      })
    }

    const texture = new CanvasTexture(canvas)
    const worldWidth = 1.0
    const worldHeight = worldWidth * (height / width)
    const geometry = new PlaneGeometry(worldWidth, worldHeight)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    })
    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.rotation.z = Math.PI / 3
    return mesh
  }
}
