import type { DeviceItem } from '@/stores/configStore'

const USEFUL_SYSTEM_AUDIO_TERMS = [
  'blackhole',
  'soundflower',
  'loopback',
  'stereo mix',
  '立体声混音',
  'what u hear',
  'ishowu',
]

const NOISY_AUDIO_DEVICE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /zoomaudiodevice|zoom audio/i, reason: '会议软件虚拟设备' },
  { pattern: /microsoft teams audio|teams audio/i, reason: '会议软件虚拟设备' },
  { pattern: /webex|slack audio|discord/i, reason: '软件虚拟设备' },
  { pattern: /obs virtual|obs audio|obs-audio/i, reason: '录屏软件虚拟设备' },
  { pattern: /background music|eqmac|krisp|nvidia broadcast/i, reason: '音频增强/路由软件' },
  { pattern: /ndi audio|screenflow|sound siphon|audio hijack/i, reason: '音频路由软件' },
  { pattern: /aggregate device|multi-output device|multi output/i, reason: '聚合/多输出设备' },
  { pattern: /virtual/i, reason: '虚拟设备' },
]

function normalizeAudioDeviceName(name: string) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

function getHiddenAudioDeviceReason(device: DeviceItem): string | null {
  const name = normalizeAudioDeviceName(device.name)
  if (device.is_loopback || USEFUL_SYSTEM_AUDIO_TERMS.some((term) => name.includes(term))) {
    return null
  }
  return NOISY_AUDIO_DEVICE_PATTERNS.find(({ pattern }) => pattern.test(device.name))?.reason ?? null
}

export function splitAudioDevices(devices: DeviceItem[]) {
  const visible: DeviceItem[] = []
  const hidden: Array<{ device: DeviceItem; reason: string }> = []
  for (const device of devices) {
    const reason = getHiddenAudioDeviceReason(device)
    if (reason) hidden.push({ device, reason })
    else visible.push(device)
  }
  return { visible, hidden }
}

/** 默认采集设备: 优先当前系统输出的 loopback, 其次任意 loopback, 最后第一台设备 */
export function pickDefaultAudioDevice(devices: DeviceItem[]): number | null {
  const loopback = devices.find((d) => d.is_loopback && d.is_default_output)
    ?? devices.find((d) => d.is_loopback)
  return loopback?.id ?? devices[0]?.id ?? null
}
