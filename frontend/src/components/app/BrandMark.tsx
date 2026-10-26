/** 面试Ace 品牌标识: 霁蓝→冰蓝渐变方角块, 白色 A 字 + 声波横杠。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ace-brand-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3B4ED8" />
          <stop offset="1" stopColor="#7C8CF8" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="6" fill="url(#ace-brand-gradient)" />
      {/* A 字两腿 */}
      <path
        d="M9.5 25 L16 7 L22.5 25"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 横杠画成三段声波 (两腿之间的空隙) */}
      <rect x="13.55" y="17.75" width="1.5" height="1.7" rx="0.75" fill="#FFFFFF" />
      <rect x="15.25" y="16.75" width="1.5" height="2.9" rx="0.75" fill="#FFFFFF" />
      <rect x="16.95" y="17.75" width="1.5" height="1.7" rx="0.75" fill="#FFFFFF" />
    </svg>
  )
}
