'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { ClipboardList } from 'lucide-react'
import { LIFECYCLES, ps, type Pothole } from '@/lib/pitscout'
import { Badge, Empty, ErrorBox, PageHeader, Spinner, STATUS_COLOR, Stat, btnPrimary, fmtDate, pct } from '@/components/pitscout/ui'

interface Summary {
  potholes: number
  reports: number
  videos: number
  potholes_by_status: Record<string, number>
  detections_by_match_status: Record<string, number>
}

export default function PotholesPage() {
  const [status, setStatus] = useState('')
  const [data, setData] = useState<{ status: string; items: Pothole[] } | null>(null)
  const items = data && data.status === status ? data.items : null // null => loading for the selected filter
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ps.get<Summary>('pitscout/summary').then(setSummary).catch((e) => setError(e.message))
  }, [])
  useEffect(() => {
    ps.get<{ items: Pothole[] }>(`potholes?limit=200${status ? `&status=${status}` : ''}`)
      .then((r) => setData({ status, items: r.items }))
      .catch((e) => { setError(e.message); setData({ status, items: [] }) })
  }, [status])

  return (
    <div className="flex flex-col gap-6 py-4">
      <PageHeader icon={ClipboardList} title="Pothole records" subtitle="One record per physical pothole, with every supporting report." />
      {error && <ErrorBox message={error} />}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <Stat label="Potholes" value={summary.potholes} />
          <Stat label="Reports" value={summary.reports} />
          <Stat label="Videos analysed" value={summary.videos} />
          <Stat label="Awaiting review" value={summary.detections_by_match_status.uncertain ?? 0} hint="uncertain duplicates" />
        </div>
      )}
      <label className="text-xs text-slate-400">
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-2 rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-white">
          <option value="">All</option>
          {LIFECYCLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      {items === null ? <Spinner label="Loading potholes…" /> : items.length === 0 ? (
        <Empty title={status ? `No potholes with status “${status}”` : 'No potholes recorded yet'}>
          {!status && <>Submit a <Link href="/report" className="text-cyan-400 underline">photo</Link> or <Link href="/video" className="text-cyan-400 underline">video</Link> with a location to create the first record.</>}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#111C2E]">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="p-3">Pothole</th><th>Status</th><th>Reports</th><th>Best confidence</th><th>Location</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="border-t border-white/5 text-slate-200">
                  <td className="p-3"><Link href={`/potholes/${p.id}`} className="font-mono text-cyan-400 underline">{p.id.slice(0, 8)}</Link></td>
                  <td><Badge className="border-white/15" ><span style={{ color: STATUS_COLOR[p.lifecycle_status] }}>{p.lifecycle_status}</span></Badge></td>
                  <td>{p.report_count}</td>
                  <td>{pct(p.best_confidence)}</td>
                  <td className="font-mono">{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</td>
                  <td>{fmtDate(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link href="/map" className={`${btnPrimary} self-start`}>View on map</Link>
    </div>
  )
}
