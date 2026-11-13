'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { History as HistoryIcon } from 'lucide-react'
import { ps, type Report, type VideoJob } from '@/lib/pitscout'
import { Badge, Empty, ErrorBox, PageHeader, Spinner, card, fmtDate } from '@/components/pitscout/ui'

export default function HistoryPage() {
  const [tab, setTab] = useState<'reports' | 'videos'>('reports')
  const [reports, setReports] = useState<Report[] | null>(null)
  const [videos, setVideos] = useState<VideoJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ps.get<{ items: Report[] }>('pothole-reports?limit=100').then((r) => setReports(r.items)).catch((e) => { setError(e.message); setReports([]) })
    ps.get<{ items: VideoJob[] }>('videos?limit=100').then((r) => setVideos(r.items)).catch((e) => { setError(e.message); setVideos([]) })
  }, [])

  const tabBtn = (t: typeof tab, label: string) => (
    <button role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
      className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? 'border border-cyan-500/30 bg-cyan-500/15 text-cyan-400' : 'text-slate-300 hover:bg-slate-800/60'}`}>{label}</button>
  )

  return (
    <div className="flex flex-col gap-6 py-4">
      <PageHeader icon={HistoryIcon} title="Detection history" subtitle="Every image report and video analysis, newest first." />
      {error && <ErrorBox message={error} />}
      <div role="tablist" className="flex gap-2">{tabBtn('reports', `Reports${reports ? ` (${reports.length})` : ''}`)}{tabBtn('videos', `Videos${videos ? ` (${videos.length})` : ''}`)}</div>

      {tab === 'reports' && (reports === null ? <Spinner label="Loading reports…" /> : reports.length === 0 ? (
        <Empty title="No reports yet">Create one from <Link href="/report" className="text-cyan-400 underline">Report a pothole</Link>.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.map((r) => (
            <li key={r.id} className={`${card} flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300`}>
              <div>
                <div className="font-bold text-white">{r.source === 'video' ? 'Video report' : 'Photo report'} <span className="font-mono text-slate-500">{r.id.slice(0, 8)}</span></div>
                <div className="text-slate-400">{fmtDate(r.created_at)} · {r.original_filename ?? 'unnamed'}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border-white/15">{r.location_status === 'pending' ? 'pending location' : `location ${r.location_status}`}</Badge>
                <Badge className="border-white/15">{r.summary.new} new · {r.summary.matched} linked · {r.summary.uncertain} review · {r.summary.pending_location} pending</Badge>
                {[...new Set(r.detections.map((d) => d.pothole_id).filter(Boolean))].slice(0, 3).map((pid) => (
                  <Link key={pid} href={`/potholes/${pid}`} className="font-mono text-cyan-400 underline">{pid!.slice(0, 8)}</Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ))}

      {tab === 'videos' && (videos === null ? <Spinner label="Loading videos…" /> : videos.length === 0 ? (
        <Empty title="No videos analysed yet">Upload one on the <Link href="/video" className="text-cyan-400 underline">Video detection</Link> page.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {videos.map((v) => (
            <li key={v.id} className={`${card} flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300`}>
              <div>
                <div className="font-bold text-white">{v.original_filename ?? 'video'} <span className="font-mono text-slate-500">{v.id.slice(0, 8)}</span></div>
                <div className="text-slate-400">{fmtDate(v.created_at)}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge className="border-white/15">{v.status}</Badge>
                {v.summary && <Badge className="border-white/15">{v.summary.total_unique_potholes} unique · {v.summary.raw_detections} raw detections</Badge>}
                {v.error && <span className="text-red-300">{v.error}</span>}
              </div>
            </li>
          ))}
        </ul>
      ))}
    </div>
  )
}
