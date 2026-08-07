export interface PreviewPoint {
  x: number
  y: number
}

export interface PreviewRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewElementContext {
  pageUrl: string
  pageTitle: string | null
  tagName: string
  selector: string | null
  text: string
  htmlPreview: string
  styles: string
  componentName: string | null
  pickedAt: string
}

export interface PreviewElementTarget {
  id: string
  element: PreviewElementContext
  rect: PreviewRect
}

export interface PreviewRegionTarget {
  id: string
  rect: PreviewRect
}

export interface PreviewStrokeTarget {
  id: string
  color: string
  width: number
  points: PreviewPoint[]
  bounds: PreviewRect
}

export interface PreviewStyleChange {
  targetId: string
  selector: string | null
  property: string
  previousValue: string
  value: string
}

export interface PreviewAnnotation {
  id: string
  pageUrl: string
  pageTitle: string | null
  comment: string
  elements: PreviewElementTarget[]
  regions: PreviewRegionTarget[]
  strokes: PreviewStrokeTarget[]
  styleChanges: PreviewStyleChange[]
  screenshot: { dataUrl: string; width: number; height: number } | null
  createdAt: string
}

export interface PreviewCapture {
  id: string
  name: string
  dataUrl: string
  mime: string
}

export function buildPreviewAnnotationPrompt(annotation: PreviewAnnotation): string {
  const lines = [
    '<preview_annotation>',
    `Page: ${annotation.pageTitle?.trim() || annotation.pageUrl}`,
  ]
  if (annotation.comment.trim()) lines.push(`Request: ${annotation.comment.trim()}`)
  if (annotation.elements.length) {
    lines.push('Selected elements:')
    for (const target of annotation.elements) {
      const element = target.element
      lines.push(`- ${element.selector || element.tagName}`)
      if (element.componentName) lines.push(`  Component: ${element.componentName}`)
      if (element.text) lines.push(`  Text: ${element.text}`)
      if (element.htmlPreview) lines.push(`  HTML: ${element.htmlPreview}`)
      if (element.styles) lines.push(`  Styles: ${element.styles}`)
    }
  }
  if (annotation.regions.length) {
    lines.push(
      `Marked regions: ${annotation.regions
        .map((target) => `${Math.round(target.rect.width)}x${Math.round(target.rect.height)} at ${Math.round(target.rect.x)},${Math.round(target.rect.y)}`)
        .join('; ')}`,
    )
  }
  if (annotation.strokes.length) {
    lines.push(`Freehand markings: ${annotation.strokes.length}`)
  }
  if (annotation.styleChanges.length) {
    lines.push('Requested style changes:')
    for (const change of annotation.styleChanges) {
      lines.push(
        `- ${change.selector || change.targetId}: ${change.property}: ${change.previousValue || '(unset)'} -> ${change.value}`,
      )
    }
  }
  if (annotation.screenshot) lines.push('An annotated preview screenshot is attached.')
  lines.push('</preview_annotation>')
  return lines.join('\n')
}

export function annotationLabel(annotation: PreviewAnnotation): string {
  if (annotation.comment.trim()) return annotation.comment.trim()
  if (annotation.elements.length === 1) {
    return annotation.elements[0].element.selector || annotation.elements[0].element.tagName
  }
  const parts = []
  if (annotation.elements.length) parts.push(`${annotation.elements.length} elements`)
  if (annotation.regions.length) parts.push(`${annotation.regions.length} regions`)
  if (annotation.strokes.length) parts.push(`${annotation.strokes.length} drawings`)
  return parts.join(', ') || 'Preview annotation'
}

export const PREVIEW_ANNOTATION_EVENT = 'nix-preview-annotation'
export const PREVIEW_CAPTURE_EVENT = 'nix-preview-capture'
