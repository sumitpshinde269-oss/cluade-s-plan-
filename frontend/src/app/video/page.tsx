'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Film, Loader2 } from 'lucide-react'
import { msg, evidenceSrc, locationToJson, ps, type Loc, type Report, type VideoJob } from '@/lib/pitscout'
import { LocationPicker } from '@/components/pitscout/LocationPicker'
import { ReportResult } from '@/components/pitscout/ReportResult'
import { BoxedImage, Empty, ErrorBox, PageHeader, Stat, btnPrimary, card, fmtTime, input, pct } from '@/components/pitscout/ui'

export default function VideoPage() {
  const [file, setFile] = useState<File | null>(null)
  const [fps, setFps] = useState('5')
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>('idle')
  const [upload, setUpload] = useState(0)
  const [job, setJob] = useState<VideoJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [loc, setLoc] = useState<Loc | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [reporting, setReporting] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const idemKey = useRef('')

  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const poll = (id: string) => {
    timer.current = setInterval(async () => {
      try {
        const j = await ps.get<VideoJob>(`videos/${id}`)
        setJob(j)
        if (j.status === 'completed' || j.status === 'failed') {
          clearInterval(timer.current!)
          setPhase('idle')
          if (j.status === 'failed') setError(j.error ?? 'Video processing failed.')
        }
      } catch (e) {
        clearInterval(timer.current!)
        setPhase('idle')
        setError(msg(e))
      }
    }, 1000)
  }

  const start = async () => {
    if (!file) return
    setError(null); setJob(null); setReport(null); setUpload(0); setPhase('uploading')
    try {
      const form = new FormData()
      form.set('file', file)
      form.set('sample_fps', fps)
      const { id } = await ps.upload<{ id: string }>('videos', form, {}, setUpload)
      idemKey.current = crypto.randomUUID()
      setPhase('processing')
      setJob({ id, status: 'queued', progress: 0, error: null, original_filename: file.name, created_at: '' })
      poll(id)
    } catch (e) {
      setPhase('idle')
      setError(msg(e))
    }
  }

  const submitReport = async () => {
    if (!job) return
    setReporting(true); setError(null)
    try {
      setReport(await ps.send<Report>('POST', `videos/${job.id}/report`, locationToJson(loc), { 'Idempotency-Key': idemKey.current }))
    } catch (e) {
      setError(msg(e))
    } finally {
      setReporting(false)
    }
  }

  const res = job?.status === 'completed' ? job.result : undefined
  const tracks = res ? res.tracks.filter((t) => showAll || t.confirmed) : []

  return (
    <div className="flex flex-col gap-6 py-4">
      <PageHeader icon={Film} title="Video detection" subtitle="Frames are sampled and checked for potholes; the same pothole seen across frames is tracked and counted once." />

      <div className={`${card} flex flex-col gap-4`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-slate-400 sm:col-span-2">
            Video file (MP4, MOV, AVI, MKV or WEBM, up to 200 MB)
            <input type="file" accept=".mp4,.mov,.avi,.mkv,.webm,video/*" className={`${input} mt-1`} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setJob(null); setReport(null); setError(null) }} />
          </label>
          <label className="text-xs text-slate-400">
            Frames analysed per second
            <select className={`${input} mt-1`} value={fps} onChange={(e) => setFps(e.target.value)}>
              {['1', '2', '5', '10'].map((v) => <option key={v} value={v}>{v} per second{v === '5' ? ' (default)' : ''}</option>)}
            </select>
          </label>
        </div>
        <button className={`${btnPrimary} self-start`} disabled={!file || phase !== 'idle'} onClick={start}>
          {phase !== 'idle' ? <><Loader2 className="h-4 w-4 animate-spin" /> Working…</> : 'Analyse video'}
        </button>

        {phase !== 'idle' && (
          <div role="status" aria-live="polite" className="text-xs text-slate-300">
            <div className="mb-1">{phase === 'uploading' ? `Uploading… ${Math.round(upload * 100)}%` : `Processing… ${Math.round((job?.progress ?? 0) * 100)}%`}</div>
            <div className="h-2 overflow-hidden rounded bg-slate-800">
              <div className="h-full bg-cyan-400 transition-all" style={{ width: `${Math.round((phase === 'uploading' ? upload : job?.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {error && <ErrorBox message={error} />}
      </div>

      {res && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-5">
            <Stat label="Unique potholes tracked" value={res.total_unique_potholes} hint={`seen in ≥${res.min_track_hits} sampled frames`} />
            <Stat label="Unconfirmed tracks" value={res.unconfirmed_tracks} hint="seen in fewer frames" />
            <Stat label="Raw detections" value={res.raw_detections} hint="before tracking" />
            <Stat label="Frames analysed" value={res.sampled_frames} hint={`of ${res.video.duration_s ?? '?'} s video`} />
            <Stat label="Frames with potholes" value={res.frames_with_detections} />
          </div>

          {res.tracks.length === 0 ? (
            <Empty title="No potholes detected in this video">The model found nothing above its confidence threshold in the analysed frames.</Empty>
          ) : (
            <>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show unconfirmed tracks too
              </label>
              <div className="grid gap-4 lg:grid-cols-2">
                {tracks.map((t) => (
                  <div key={t.track_id} className={`${card} flex flex-col gap-3`}>
                    <BoxedImage src={evidenceSrc(t.evidence_url)} width={t.image_width} height={t.image_height} alt={`Best frame of tracked pothole ${t.track_id}`}
                      boxes={[{ bbox: t.best_bbox, label: `#${t.track_id} ${pct(t.best_confidence)}`, color: t.confirmed ? '#22d3ee' : '#94a3b8' }]} />
                    <div className="text-xs text-slate-300">
                      <strong className="text-white">Tracked pothole #{t.track_id}</strong>{!t.confirmed && <span className="ml-2 text-amber-300">unconfirmed</span>}
                      <div className="mt-1 font-mono text-slate-400">
                        {fmtTime(t.first_timestamp_s)}–{fmtTime(t.last_timestamp_s)} · {t.hits} frame(s) · best {pct(t.best_confidence)} · mean {pct(t.mean_confidence)}
                      </div>
                    </div>
                    <details className="text-xs text-slate-400">
                      <summary className="cursor-pointer text-cyan-400">Frame-level detections</summary>
                      <table className="mt-2 w-full text-left font-mono text-[11px]">
                        <thead><tr className="text-slate-500"><th>Frame</th><th>Time</th><th>Confidence</th><th>Box (x1,y1,x2,y2)</th></tr></thead>
                        <tbody>{t.frames.map((f) => <tr key={f.frame_index}><td>{f.frame_index}</td><td>{fmtTime(f.timestamp_s)}</td><td>{pct(f.confidence)}</td><td>{f.bbox.join(', ')}</td></tr>)}</tbody>
                      </table>
                    </details>
                  </div>
                ))}
              </div>
            </>
          )}

          {res.total_unique_potholes > 0 && !report && (
            <div className={`${card} flex flex-col gap-3`}>
              <h2 className="text-sm font-bold text-white">Submit as a report</h2>
              <p className="text-xs text-slate-400">
                Where was this footage recorded? One location is applied to all {res.total_unique_potholes} confirmed potholes. Each one is checked against existing records for duplicates.
              </p>
              <LocationPicker value={loc} onChange={setLoc} />
              <button className={`${btnPrimary} self-start`} disabled={reporting} onClick={submitReport}>
                {reporting ? 'Submitting…' : loc ? 'Submit report' : 'Submit without location (pending verification)'}
              </button>
            </div>
          )}
          {report && <ReportResult report={report} onChange={setReport} />}
        </>
      )}
    </div>
  )
}
