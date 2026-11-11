import { useState, useEffect, useMemo } from 'react'
import { RefreshCw, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import { GradientCard } from './shared'
import { buildApiUrl } from '@/lib/backendUrl'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

type NetworkUrl = {
  ip: string
  interface: string
  label: string
  url: string
}

type NetworkInfo = {
  url?: string
  urls?: NetworkUrl[]
  https_urls?: NetworkUrl[]
}

function addMobileParams(rawUrl: string, mode: string): string {
  try {
    const url = new URL(rawUrl)
    url.searchParams.set('mobile', '1')
    url.searchParams.set('mode', mode === 'ai-interview' ? 'ai-interview' : 'assist')
    return url.toString()
  } catch {
    return rawUrl
  }
}

export default function NetworkQRCode() {
  const [qrSrc, setQrSrc] = useState<string | null>(null)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null)
  const [selectedUrl, setSelectedUrl] = useState('')
  const [nonce, setNonce] = useState(0)
  const appMode = useUiPrefsStore((s) => s.appMode)

  const candidates = useMemo(() => {
    const all = networkInfo?.urls?.length
      ? networkInfo.urls
      : networkInfo?.url
        ? [{ ip: '', interface: '', label: '默认地址', url: networkInfo.url }]
        : []
    return all.map((item) => ({
      ...item,
      url: addMobileParams(item.url, appMode),
    }))
  }, [appMode, networkInfo])

  useEffect(() => {
    let cancelled = false

    async function loadNetworkQr() {
      try {
        const response = await fetch(buildApiUrl('/api/network-info'))
        if (cancelled) return
        const data = await response.json() as NetworkInfo
        if (cancelled) return
        setNetworkInfo(data)
        const nextCandidates = data.urls?.length
          ? data.urls
          : data.url
            ? [{ ip: '', interface: '', label: '默认地址', url: data.url }]
            : []
        const preferred = nextCandidates[0]?.url
          ? addMobileParams(nextCandidates[0].url, appMode)
          : ''
        setSelectedUrl((current) => {
          if (current && nextCandidates.some((item) => addMobileParams(item.url, appMode) === current)) {
            return current
          }
          return preferred
        })
      } catch {
        // Network QR is optional; keep settings usable if LAN discovery fails.
      }
    }

    void loadNetworkQr()
    return () => {
      cancelled = true
    }
  }, [appMode, nonce])

  useEffect(() => {
    let cancelled = false
    async function renderQr() {
      if (!selectedUrl) {
        setQrSrc(null)
        return
      }
      try {
        const src = await QRCode.toDataURL(selectedUrl, {
          width: 200,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        })
        if (cancelled) return
        setQrSrc(src)
      } catch {
        if (!cancelled) setQrSrc(null)
      }
    }
    void renderQr()
    return () => {
      cancelled = true
    }
  }, [selectedUrl])

  if (!selectedUrl) return null
  const isHttps = selectedUrl.startsWith('https://')
  const hasHttps = Boolean(networkInfo?.https_urls?.length)

  return (
    <GradientCard className="p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-text-muted uppercase tracking-wider">
        <Smartphone className="w-3.5 h-3.5" />
        手机扫码访问
        <button
          type="button"
          onClick={() => setNonce((value) => value + 1)}
          className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary"
          aria-label="重新检测局域网地址"
          title="重新检测局域网地址"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-2">
        {qrSrc && <img src={qrSrc} alt="QR Code" className="rounded-lg" width={160} height={160} />}
        {candidates.length > 1 && (
          <select
            value={selectedUrl}
            onChange={(event) => setSelectedUrl(event.target.value)}
            aria-label="扫码访问地址"
            className="w-full rounded-md border border-bg-hover/50 bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary"
          >
            {candidates.map((item) => (
              <option key={item.url} value={item.url}>
                {item.label || item.interface || '网络地址'} · {item.ip || item.url}
              </option>
            ))}
          </select>
        )}
        <p className="text-[11px] text-accent-blue break-all text-center select-all">{selectedUrl}</p>
        <p className="text-[10px] text-text-muted text-center">
          当前打开：{appMode === 'ai-interview' ? 'AI 面试' : '实时辅助'}
        </p>
        {isHttps ? (
          <p className="rounded-md bg-accent-amber/8 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">
            手机首次打开会提示证书不受信任。选择“继续访问”后才能使用手机麦克风采集。
          </p>
        ) : (
          <p className="rounded-md bg-accent-red/8 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">
            当前只有 HTTP 地址，手机浏览器会禁止麦克风。请确认防火墙允许本应用访问局域网，并重新检测。
          </p>
        )}
        {!hasHttps && (
          <p className="text-[10px] text-text-muted text-center">
            如果仍无法访问，请关闭 VPN/代理或允许 Python/面试Ace 通过防火墙。
          </p>
        )}
      </div>
    </GradientCard>
  )
}
