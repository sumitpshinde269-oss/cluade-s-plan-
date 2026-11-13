'use client'

import React from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { Lifecycle, MatchStatus } from '@/lib/pitscout'

export const card = 'rounded-2xl border border-white/10 bg-[#111C2E] p-5 shadow-xl'
export const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50'
export const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50'
export const input =
  'w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400'

export const MATCH_INFO: Record<MatchStatus, { label: string; cls: string; help: string }> = {
  new: { label: 'New pothole', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', help: 'No existing record matched, so a new pothole record was created.' },
  matched: { label: 'Duplicate – linked', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30', help: 'Same physical pothole as an existing record; this report was added as extra evidence.' },
  uncertain: { label: 'Needs review', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', help: 'Close to an existing pothole but not clearly the same one. Nothing was merged; please review.' },
  pending_location: { label: 'Pending location', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/30', help: 'No location was provided, so this cannot be matched or mapped yet.' },
}

export const STATUS_COLOR: Record<Lifecycle, string> = {
  reported: '#f59e0b',
  verified: '#ef4444',
  scheduled: '#3b82f6',
  repaired: '#22c55e',
  rejected: '#64748b',
}

export function Badge({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${className}`}>{children}</span>
}

export const MatchBadge = ({ status }: { status: MatchStatus }) => (
  <Badge className={MATCH_INFO[status].cls}>{MATCH_INFO[status].label}</Badge>
)

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> {label}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-xs text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <span>{message}</span>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center">
      <p className="text-sm font-bold text-white">{title}</p>
      {children && <div className="mt-2 text-xs text-slate-400">{children}</div>}
    </div>
  )
}

export function PageHeader({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle: string }) {
  return (
    <div className="border-b border-white/10 pb-4">
      <h1 className="flex items-center gap-2 text-2xl font-extrabold text-white md:text-3xl">
        <Icon className="h-7 w-7 text-cyan-400" aria-hidden /> {title}
      </h1>
      <p className="mt-1 text-xs text-slate-400 md:text-sm">{subtitle}</p>
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#111C2E] p-3.5">
      <span className="font-mono text-[10px] uppercase text-slate-400">{label}</span>
      <div className="mt-1 text-lg font-extrabold text-white">{value}</div>
      {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
    </div>
  )
}

/** Image with SVG boxes; viewBox = image pixel size so boxes stay aligned at any display size. */
export function BoxedImage({
  src, width, height, boxes, alt,
}: {
  src: string
  width: number
  height: number
  boxes: { bbox: number[]; label?: string; color?: string }[]
  alt: string
}) {
  const stroke = Math.max(2, Math.round(width / 300))
  const font = Math.max(12, Math.round(width / 45))
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="block h-auto w-full" />
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" aria-hidden>
        {boxes.map((b, i) => {
          const [x1, y1, x2, y2] = b.bbox
          const color = b.color || '#facc15'
          return (
            <g key={i}>
              <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={color} strokeWidth={stroke} />
              {b.label && (
                <text x={x1} y={Math.max(font, y1 - 4)} fill={color} fontSize={font} fontWeight={700} stroke="#000" strokeWidth={font / 6} paintOrder="stroke">
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
export const fmtDate = (iso: string) => new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString()
export const pct = (v: number) => `${Math.round(v * 100)}%`
