'use client'

import React, { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, MapPin } from 'lucide-react'
import { msg, LIFECYCLES, evidenceSrc, ps, type Lifecycle, type Pothole } from '@/lib/pitscout'
import { PotholeMap } from '@/components/pitscout/PotholeMap'
import { BoxedImage, Badge, ErrorBox, MatchBadge, Spinner, STATUS_COLOR, Stat, btnPrimary, card, fmtDate, input, pct } from '@/components/pitscout/ui'

function Detail() {
  const id = useParams()?.id as string
  const [p, setP] = useState<Pothole | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [next, setNext] = useState<Lifecycle>('verified')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => ps.get<Pothole>(`potholes/${id}`).then(setP).catch((e) => setError(e.message)), [id])
  useEffect(() => { if (id) load() }, [id, load])

  if (error && !p) return <ErrorBox message={error} />
  if (!p) return <Spinner label="Loading pothole…" />

  const update = async () => {
    setBusy(true); setError(null)
    try { setP(await ps.send<Pothole>('PATCH', `potholes/${p.id}/status`, { status: next, note: note || null })); setNote('') }
    catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-6 py-4">
      <Link href="/potholes" className="inline-flex items-center gap-1 text-xs text-cyan-400"><ArrowLeft className="h-3.5 w-3.5" /> All potholes</Link>
      <div>
        <h1 className="text-2xl font-extrabold text-white">Pothole <span className="font-mono text-cyan-400">{p.id.slice(0, 8)}</span></h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <Badge className="border-white/15"><span style={{ color: STATUS_COLOR[p.lifecycle_status] }}>{p.lifecycle_status}</span></Badge>
          <Badge className="border-white/15 text-slate-300">{p.verification_status}</Badge>
          <span className="font-mono">{p.lat.toFixed(6)}, {p.lon.toFixed(6)}</span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Reports" value={p.report_count} hint="independent submissions" />
        <Stat label="Best confidence" value={pct(p.best_confidence)} />
        <Stat label="First reported" value={<span className="text-sm">{fmtDate(p.created_at)}</span>} />
      </div>

      <section className={card} aria-label="Location"><h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-white"><MapPin className="h-4 w-4 text-cyan-400" /> Location</h2>
        <PotholeMap height="300px" markers={[{ id: p.id, lat: p.lat, lon: p.lon, color: STATUS_COLOR[p.lifecycle_status], title: `Pothole ${p.id.slice(0, 8)}` }]} />
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-bold text-white">Evidence and duplicate matching ({p.detections?.length ?? 0})</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {p.detections?.map((d, i) => (
            <div key={d.id} className="flex flex-col gap-2 rounded-xl border border-white/10 bg-slate-900/50 p-3 text-xs text-slate-300">
              {d.evidence_url && <BoxedImage src={evidenceSrc(d.evidence_url)} width={d.image_width} height={d.image_height} alt={`Evidence ${i + 1}`} boxes={[{ bbox: d.bbox, label: pct(d.confidence) }]} />}
              <div className="flex flex-wrap items-center gap-2"><MatchBadge status={d.match_status} /><span className="font-mono text-slate-400">{pct(d.confidence)} confidence</span></div>
              <p className="text-slate-400">{d.match_meta?.reason}</p>
              {d.match_meta?.candidates?.filter((c) => c.pothole_id === p.id).map((c) => (
                <p key={c.pothole_id} className="font-mono text-[11px] text-slate-500">
                  at match time: {c.distance_m.toFixed(1)} m apart (limit {c.radius_m.toFixed(0)} m) · visual similarity {c.visual_sim?.toFixed(2) ?? 'n/a'}
                </p>
              ))}
              <Link href="/history" className="text-cyan-400 underline">Report {d.report_id?.slice(0, 8)}</Link>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 text-sm font-bold text-white">Location history</h2>
          <ul className="flex flex-col gap-2 text-xs text-slate-300">
            {p.reports?.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-white/5 p-2">
                <span className="font-mono">{r.location ? `${r.location.lat.toFixed(6)}, ${r.location.lon.toFixed(6)}` : 'no location'}</span>
                <span className="text-slate-400">{r.location ? `${r.location.source}${r.location.accuracy_m != null ? ` ±${Math.round(r.location.accuracy_m)} m` : ', accuracy unknown'}` : ''} · {r.source} · {fmtDate(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={card}>
          <h2 className="mb-3 text-sm font-bold text-white">Status history</h2>
          <ol className="mb-4 flex flex-col gap-2 text-xs text-slate-300">
            {p.status_history?.map((h, i) => (
              <li key={i} className="rounded-lg border border-white/5 p-2">
                <strong>{h.from ? `${h.from} → ` : ''}{h.to}</strong> <span className="text-slate-500">· {h.actor} · {fmtDate(h.at)}</span>
                {h.note && <div className="text-slate-400">{h.note}</div>}
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-2">
            <label className="text-[11px] text-slate-400">Change status
              <select className={`${input} mt-1`} value={next} onChange={(e) => setNext(e.target.value as Lifecycle)}>
                {LIFECYCLES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-slate-400">Note (optional)<input className={`${input} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></label>
            <button className={`${btnPrimary} self-start`} disabled={busy || next === p.lifecycle_status} onClick={update}>{busy ? 'Saving…' : 'Update status'}</button>
            {error && <ErrorBox message={error} />}
          </div>
        </section>
      </div>
    </div>
  )
}

export default function PotholeDetailPage() {
  return <Suspense fallback={<Spinner label="Loading pothole…" />}><Detail /></Suspense>
}
