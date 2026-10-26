import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { oneDark, oneLight, a11yDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ColorSchemeId } from '@/lib/colorScheme'

const PRISM_LANGUAGE_REGISTRY: Record<string, unknown> = {
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  'shell-session': bash,
  c,
  cpp,
  'c++': cpp,
  csharp,
  cs: csharp,
  'c#': csharp,
  css,
  diff,
  docker,
  dockerfile: docker,
  go,
  html: markup,
  java,
  javascript,
  js: javascript,
  json,
  jsx,
  kotlin,
  markdown,
  md: markdown,
  markup,
  php,
  python,
  py: python,
  ruby,
  rust,
  rs: rust,
  sql,
  svg: markup,
  swift,
  tsx,
  typescript,
  ts: typescript,
  xml: markup,
  yaml,
  yml: yaml,
}

export function parseMarkdownFenceLanguage(className?: string) {
  const match = /language-([A-Za-z0-9+#-]+)/.exec(className || '')
  return match?.[1].toLowerCase() ?? null
}

export function resolvePrismLanguage(requestedLang: string | null) {
  if (!requestedLang) return null
  return requestedLang in PRISM_LANGUAGE_REGISTRY ? requestedLang : null
}

for (const [languageName, languageModule] of Object.entries(PRISM_LANGUAGE_REGISTRY)) {
  SyntaxHighlighter.registerLanguage(languageName, languageModule)
}

function prismThemeForScheme(id: ColorSchemeId) {
  if (id === 'ace-light') return oneLight
  if (id === 'ace-hc') return a11yDark
  return oneDark
}

function CopyButton({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // 卸载时清掉残留 timer, 避免已卸载组件仍触发 setState
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])
  const settle = (nextState: 'copied' | 'failed') => {
    if (!mountedRef.current) return
    setCopyState(nextState)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle')
    }, 2000)
  }
  const handleCopy = async () => {
    if (copyState === 'copying') return
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    setCopyState('copying')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      settle('copied')
    } catch {
      settle('failed')
    }
  }
  const isCopying = copyState === 'copying'
  const label = copyState === 'copied'
    ? '已复制'
    : copyState === 'failed'
      ? '复制失败'
      : isCopying
        ? '复制中…'
        : '复制'
  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={isCopying}
      className="inline-flex size-[26px] items-center justify-center rounded-md text-text-muted transition-all hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait"
      title={copyState === 'failed' ? '复制失败，请检查浏览器权限' : copyState === 'copied' ? '已复制' : '复制代码'}
      aria-label={label}
    >
      {copyState === 'copied' ? (
        <Check className="w-3.5 h-3.5 text-accent-green" />
      ) : copyState === 'failed' ? (
        <X className="w-3.5 h-3.5 text-accent-red" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  )
}

function useMarkdownComponents(colorScheme: ColorSchemeId) {
  const prismStyle = prismThemeForScheme(colorScheme)
  return useMemo(
    () => ({
      code({ className, children, ...props }: { className?: string; children?: React.ReactNode } & Record<string, unknown>) {
        const codeStr = String(children).replace(/\n$/, '')
        const requestedLang = parseMarkdownFenceLanguage(className)
        const lang = resolvePrismLanguage(requestedLang)
        if (requestedLang) {
          return (
            <div className="code-block-shell group/code my-3 rounded-lg overflow-hidden">
              <div className="code-block-head flex h-8 items-center justify-between px-2.5">
                <span className="text-xs font-medium text-text-muted">{requestedLang}</span>
                <span className="opacity-0 transition-opacity duration-150 group-hover/code:opacity-100">
                  <CopyButton text={codeStr} />
                </span>
              </div>
              {lang ? (
                <SyntaxHighlighter
                  style={prismStyle}
                  language={lang}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    fontSize: '0.82rem',
                    lineHeight: 1.55,
                    background: 'rgb(var(--c-code-shell-bg))',
                    padding: '0.9rem 1rem',
                  }}
                  codeTagProps={{ style: { fontFamily: 'JetBrains Mono, Consolas, monospace' } }}
                  wrapLongLines={false}
                >
                  {codeStr}
                </SyntaxHighlighter>
              ) : (
                <pre
                  className="m-0 overflow-x-auto bg-[rgb(var(--c-code-shell-bg))] px-4 py-3 text-[0.82rem] leading-[1.55] text-text-primary"
                >
                  <code style={{ fontFamily: 'JetBrains Mono, Consolas, monospace' }}>{codeStr}</code>
                </pre>
              )}
            </div>
          )
        }
        return (
          <code
            className="px-1.5 py-0.5 rounded-[5px] border-[0.5px] border-bg-hover"
            style={{
              background: 'rgb(var(--c-code-inline-bg))',
              color: 'rgb(var(--c-code-inline-fg))',
            }}
            {...props}
          >
            {children}
          </code>
        )
      },
    }),
    [prismStyle],
  )
}

/**
 * 把 markdown 源码切成块: 参考 Cherry Studio / Streamdown 的流式渲染策略 —
 * 按空行切块、跳过代码围栏内部, 已完成块配合 memo 不再重复解析,
 * 流式增量只重解析末尾块, 因此流式期间也能实时渲染完整 markdown。
 */
export function splitMarkdownBlocks(source: string): string[] {
  const lines = source.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fenceChar: '`' | '~' | null = null
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const char = fence[1][0] as '`' | '~'
      if (fenceChar === null) fenceChar = char
      else if (fenceChar === char) fenceChar = null
      current.push(line)
      continue
    }
    if (fenceChar === null && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

type MdComponents = ReturnType<typeof useMarkdownComponents>

const MarkdownBlock = memo(function MarkdownBlock({
  block,
  components,
}: {
  block: string
  components: MdComponents
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>
      {block}
    </ReactMarkdown>
  )
})

function AnswerMarkdownContentInner({
  answer,
  colorScheme,
  stream,
}: {
  answer: string
  colorScheme: ColorSchemeId
  stream: boolean
}) {
  const mdComponents = useMarkdownComponents(colorScheme)
  const blocks = useMemo(() => splitMarkdownBlocks(answer), [answer])
  return (
    <div className={`markdown-body text-sm text-text-primary leading-relaxed ${stream ? 'max-w-none' : ''}`}>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} components={mdComponents} />
      ))}
    </div>
  )
}

const AnswerMarkdownContent = memo(AnswerMarkdownContentInner)
export default AnswerMarkdownContent
