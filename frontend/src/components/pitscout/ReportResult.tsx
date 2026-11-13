'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { msg, evidenceSrc, locationToJson, ps, type Detection, type Loc, type Report } from '@/lib/pitscout'
import { LocationPicker } from './LocationPicker'
import { BoxedImage, ErrorBox, MATCH_INFO, MatchBadge, btnGhost, btnPrimary, card, pct } from './ui'

const BOX_COLOR: Record<string, string> = { new: '#34d399', matched: '#22d3ee', uncertain: '#fbbf24', pending_location: '#94a3b8' }

export function ReportResult({ report, onChange }: { report: Report; onChange: (r: Report) => void }) {
  const [loc, setLoc] = useState<Loc | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (fn: () => Promise<Report>) => {
    setBusy(true)
    setError(null)
    try {
      onChange(await fn())
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }

  const groups = new Map<string, Detection[]>()
  report.detections.forEach((d) => groups.set(d.evidence_url ?? d.id, [...(groups.get(d.evidence_url ?? d.id) ?? []), d]))
  const s = report.summary

  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden />
        <div className="text-sm text-slate-200">
          {report.status === 'no_potholes' ? (
            <strong>No potholes were detected in this submission.</strong>
          ) : (
            <>
              <strong>{report.detections.length} pothole detection(s) recorded:</strong>{' '}
              {s.new} new · {s.matched} duplicate(s) linked · {s.uncertain} need review · {s.pending_location} pending location
            </>
          )}
          {report.idempotent_replay && <span className="ml-2 text-xs text-slate-400">(this was an already-submitted report; nothing was duplicated)</span>}
        </div>
      </div>

      {report.location_status === 'pending' && report.detections.length > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm text-amber-200">
            <strong>Pending location verification.</strong> This report has no location, so its potholes are not matched or shown on the map yet.
            Add a location to finish processing.
          </p>
          <LocationPicker value={loc} onChange={setLoc} />
          <button
            className={btnPrimary}
            disabled={!loc || busy}
            onClick={() => act(() => ps.send<Report>('POST', `pothole-reports/${report.id}/location`, locationToJson(loc)))}
          >
            {busy ? 'Saving…' : 'Add location and match'}
          </button>
        </div>
      )}
      {error && <ErrorBox message={error} />}

      {[...groups.entries()].map(([key, dets]) => (
        <div key={key} className={`${card} grid gap-4 lg:grid-cols-2`}>
          {dets[0].evidence_url && (
            <BoxedImage
              src={evidenceSrc(dets[0].evidence_url)}
              width={dets[0].image_width}
              height={dets[0].image_height}
              alt="Submitted evidence with detected potholes outlined"
              boxes={dets.map((d, i) => ({ bbox: d.bbox, label: `#${i + 1} ${pct(d.confidence)}`, color: BOX_COLOR[d.match_status] }))}
            />
          )}
          <ul className="flex flex-col gap-3">
            {dets.map((d, i) => (
              <li key={d.id} className="rounded-xl border border-white/10 bg-slate-900/50 p-3 text-xs text-slate-300">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-white">Pothole #{i + 1}</span>
                  <MatchBadge status={d.match_status} />
                  <span className="font-mono text-slate-400">{pct(d.confidence)} confidence</span>
                  {d.timestamp_s != null && <span className="font-mono text-slate-400">@ {d.timestamp_s.toFixed(1)}s</span>}
                </div>
                <p className="mt-1.5 text-slate-400">{d.match_meta?.reason ?? MATCH_INFO[d.match_status].help}</p>
                {d.pothole_id && (
                  <Link href={`/potholes/${d.pothole_id}`} className="mt-1.5 inline-block font-semibold text-cyan-400 underline">
                    Open pothole record
                  </Link>
                )}
                {d.match_status === 'uncertain' && (
                  <div className="mt-2 flex flex-col gap-2">
                    {(d.match_meta?.candidates ?? []).map((c) => (
                      <div key={c.pothole_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-2">
                        <span className="font-mono text-[11px] text-slate-400">
                          {c.distance_m.toFixed(1)} m away · visual similarity {c.visual_sim == null ? 'n/a' : c.visual_sim.toFixed(2)}
                        </span>
                        <span className="flex gap-2">
                          <Link href={`/potholes/${c.pothole_id}`} className="text-cyan-400 underline">View</Link>
                          <button disabled={busy} className={btnGhost} onClick={() => act(() => ps.send<Report>('POST', `detections/${d.id}/resolve`, { pothole_id: c.pothole_id }))}>
                            Same pothole
                          </button>
                        </span>
                      </div>
                    ))}
                    <button disabled={busy} className={btnGhost} onClick={() => act(() => ps.send<Report>('POST', `detections/${d.id}/resolve`, { pothole_id: null }))}>
                      It is a different, new pothole
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
