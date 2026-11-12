/**
 * Adapted from CookSleep/gpt_image_playground/src/lib/viewportTransform.ts.
 * Copyright (c) 2026 CookSleep. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface ViewTransform { scale: number; x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function clampViewTransform(transform: ViewTransform, size: Size): ViewTransform {
  const scale = clamp(transform.scale, 1, 8);
  if (scale === 1) return { scale, x: 0, y: 0 };
  return { scale, x: clamp(transform.x, size.width - size.width * scale, 0), y: clamp(transform.y, size.height - size.height * scale, 0) };
}
export function zoomAtPoint(transform: ViewTransform, point: Point, nextScale: number, size: Size): ViewTransform {
  const localPoint = { x: (point.x - transform.x) / transform.scale, y: (point.y - transform.y) / transform.scale };
  const scale = clamp(nextScale, 1, 8);
  return clampViewTransform({ scale, x: point.x - localPoint.x * scale, y: point.y - localPoint.y * scale }, size);
}
export function clientPointToCanvasPoint(rect: { left: number; top: number; width: number; height: number }, point: Point, size: Size): Point {
  return { x: ((point.x - rect.left) / rect.width) * size.width, y: ((point.y - rect.top) / rect.height) * size.height };
}
