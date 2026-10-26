import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AnswerMarkdownContent, { splitMarkdownBlocks } from './AnswerMarkdownContent'

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(splitMarkdownBlocks('第一段\n\n第二段\n\n\n第三段')).toEqual(['第一段', '第二段', '第三段'])
  })

  it('keeps a fenced code block with blank lines in a single block', () => {
    const source = '上文\n\n```python\na = 1\n\nb = 2\n```\n\n下文'
    expect(splitMarkdownBlocks(source)).toEqual([
      '上文',
      '```python\na = 1\n\nb = 2\n```',
      '下文',
    ])
  })

  it('treats an unclosed streaming fence as one tail block', () => {
    const source = '思路\n\n```sql\nselect 1\n\n-- 还在写'
    expect(splitMarkdownBlocks(source)).toEqual(['思路', '```sql\nselect 1\n\n-- 还在写'])
  })

  it('keeps table rows together and splits around the table', () => {
    const source = '说明\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n结尾'
    expect(splitMarkdownBlocks(source)).toEqual([
      '说明',
      '| A | B |\n| - | - |\n| 1 | 2 |',
      '结尾',
    ])
  })
})

describe('AnswerMarkdownContent', () => {
  it('renders headings, bold and lists from markdown source', () => {
    render(
      <AnswerMarkdownContent
        answer={'## 标题\n\n- 要点 **加粗**\n- 第二点'}
        colorScheme="ace-light"
        stream={false}
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: '标题' })).toBeInTheDocument()
    expect(screen.getByText('加粗').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders a GFM table', () => {
    render(
      <AnswerMarkdownContent
        answer={'| 方案 | 场景 |\n| --- | --- |\n| RDB | 快照 |'}
        colorScheme="ace-light"
        stream={false}
      />,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '快照' })).toBeInTheDocument()
  })
})
