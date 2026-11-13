'use client'

import dynamic from 'next/dynamic'
import type { MapProps } from './PotholeMapInner'

// Leaflet touches `window`, so it must only load in the browser.
export const PotholeMap = dynamic<MapProps>(() => import('./PotholeMapInner'), {
  ssr: false,
  loading: () => <div className="flex h-[420px] items-center justify-center rounded-xl border border-white/10 text-xs text-slate-400" role="status">Loading map…</div>,
})
export type { MapMarker } from './PotholeMapInner'
