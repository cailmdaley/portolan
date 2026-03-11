import type { Annotation } from './FileViewerAnnotationTypes'

const API_BASE = `http://${window.location.hostname}:4004`

interface SaveTextAnnotationInput {
  currentPath: string
  currentOriginId: string
  from: number
  to: number
  line: number
  endLine: number
  selectedText: string
  comment: string
  contextBefore: string
  contextAfter: string
}

interface SaveImageAnnotationInput {
  currentPath: string
  currentOriginId: string
  x: number
  y: number
  comment: string
}

interface SendAnnotationsInput {
  currentPath: string
  currentOriginId: string
  annotations: Annotation[]
  globalComment: string
  workerId?: string
  createNew?: boolean
}

interface FileAsFiberInput {
  currentPath: string
  currentOriginId: string
  currentCityPath: string
  annotations: Annotation[]
  globalComment: string
}

function buildFiberBody(globalComment: string, annotations: Annotation[]): string {
  const bodyLines: string[] = []
  if (globalComment) {
    bodyLines.push(globalComment, '')
  }
  if (annotations.length > 0) {
    bodyLines.push('## Annotations', '')
    annotations.forEach((ann, index) => {
      const lineRef = ann.line ? ` (L${ann.line})` : ''
      const truncatedText = ann.originalText.length > 60
        ? ann.originalText.slice(0, 57) + '...'
        : ann.originalText
      bodyLines.push(`${index + 1}.${lineRef} **"${truncatedText.replace(/\n/g, ' ')}"**`)
      bodyLines.push(`   > ${ann.comment}`)
      bodyLines.push('')
    })
  }
  return bodyLines.join('\n')
}

export async function saveTextAnnotation(input: SaveTextAnnotationInput): Promise<Annotation> {
  const response = await fetch(`${API_BASE}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: input.currentPath,
      originId: input.currentOriginId,
      from: input.from,
      to: input.to,
      line: input.line,
      endLine: input.endLine,
      originalText: input.selectedText,
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
      comment: input.comment,
    }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to save annotation')
  }
  const data = await response.json()
  return data.annotation
}

export async function saveImageAnnotation(input: SaveImageAnnotationInput): Promise<Annotation> {
  const response = await fetch(`${API_BASE}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: input.currentPath,
      originId: input.currentOriginId,
      from: 0,
      to: 0,
      originalText: `[Image point at ${input.x.toFixed(1)}%, ${input.y.toFixed(1)}%]`,
      contextBefore: '',
      contextAfter: '',
      comment: input.comment,
      x: input.x,
      y: input.y,
      isImageAnnotation: true,
    }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to save annotation')
  }
  const data = await response.json()
  return data.annotation
}

export async function loadAnnotations(currentPath: string, currentOriginId: string): Promise<Annotation[]> {
  const response = await fetch(
    `${API_BASE}/annotations?path=${encodeURIComponent(currentPath)}&originId=${encodeURIComponent(currentOriginId)}`
  )
  if (!response.ok) return []
  const data = await response.json()
  return Array.isArray(data.annotations) ? data.annotations : []
}

export async function sendAnnotationsToWorker(input: SendAnnotationsInput): Promise<void> {
  const response = await fetch(`${API_BASE}/send-annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: input.workerId,
      createNewWorker: input.createNew,
      filePath: input.currentPath,
      originId: input.currentOriginId,
      annotations: input.annotations,
      globalComment: input.globalComment || undefined,
    }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to send annotations')
  }
}

export async function fileAnnotationsAsFiber(input: FileAsFiberInput): Promise<{ fiberId: string }> {
  const filename = input.currentPath.split('/').pop() || input.currentPath
  const response = await fetch(`${API_BASE}/file-as-fiber`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: input.currentPath,
      originId: input.currentOriginId,
      cityPath: input.currentCityPath,
      title: `Feedback on ${filename}`,
      body: buildFiberBody(input.globalComment, input.annotations),
      kind: 'task',
    }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to file as fiber')
  }
  return response.json()
}
