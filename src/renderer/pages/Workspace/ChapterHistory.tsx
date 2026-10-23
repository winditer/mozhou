import { useMemo, useState, type ReactNode } from 'react'
import { History, RotateCcw, Trash2 } from 'lucide-react'
import type { Chapter } from '@shared/types'
import { formatDateTime, formatNumber, stripHtml } from '@shared/utils'
import { Button, Modal } from '../../components/ui'

/**
 * 章节历史：每次改动前的内容都会留一份。
 *
 * 以前 types 里定义了 versions 字段，从没写过——等于把"数据安全"只写在说明里。
 * 这里把快照摆到作者眼前：看得见有几份、什么时候的、多少字，并且能一键还原。
 */
export function ChapterHistory({
  open,
  chapter,
  onClose,
  onRestore,
  onClear
}: {
  open: boolean
  chapter: Chapter | null
  onClose: () => void
  /** 用某个快照替换当前正文（当前内容会再进一次快照，所以还原本身也可撤销） */
  onRestore: (snapshotId: string) => void
  onClear: () => void
}): ReactNode {
  const [previewId, setPreviewId] = useState<string | null>(null)
  // 新的在前，作者找"刚才那版"永远在最上面
  const list = useMemo(() => [...(chapter?.versions ?? [])].reverse(), [chapter?.versions])
  // 默认就选中最新一版：作者打开这个窗口十有八九是想看「刚才那版长什么样」
  const preview = list.find((v) => v.id === previewId) ?? list[0] ?? null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2 text-[13.5px]">
          <History size={15} /> 章节历史
          <span className="text-[11.5px] font-normal" style={{ color: 'var(--text-faint)' }}>
            {chapter?.title}
          </span>
        </span>
      }
      width={720}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClear} disabled={list.length === 0}>
            <Trash2 size={13} /> 清空历史
          </Button>
          <div className="flex-1" />
          <Button size="sm" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {list.length === 0 ? (
        <div className="text-[12.5px] leading-relaxed py-6 text-center" style={{ color: 'var(--text-faint)' }}>
          还没有历史版本。
          <br />
          每次你改动正文，墨舟会在改动前留一份快照（最多 20 份，一分钟内的连续编辑合成一份）。
        </div>
      ) : (
        <div className="flex gap-4" style={{ minHeight: 320 }}>
          <div className="w-[200px] shrink-0 overflow-auto scroll-thin" style={{ maxHeight: 420 }}>
            {list.map((v, i) => {
              const active = v.id === previewId
              return (
                <button
                  key={v.id}
                  onClick={() => setPreviewId(v.id)}
                  className="w-full text-left px-2.5 py-2 rounded-md mb-1"
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
                    color: active ? 'var(--accent)' : 'var(--text-dim)'
                  }}
                >
                  <div className="text-[11.5px]">
                    {i === 0 ? '最近一次改动前' : formatDateTime(v.at)}
                  </div>
                  <div className="text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    {formatNumber(v.words)} 字
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div
              className="flex-1 min-h-0 overflow-auto scroll-thin rounded-md p-3 text-[12px] leading-[1.9] selectable"
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', maxHeight: 360 }}
            >
              {preview ? (
                stripHtml(preview.content)
                  .split(/\n+/)
                  .filter(Boolean)
                  .map((p, i) => (
                    <p key={i} style={{ textIndent: '2em', margin: 0 }}>
                      {p}
                    </p>
                  ))
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>选一个版本预览</span>
              )}
            </div>
            <div className="flex justify-end mt-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!preview}
                onClick={() => {
                  if (preview) {
                    onRestore(preview.id)
                    setPreviewId(null)
                    onClose()
                  }
                }}
              >
                <RotateCcw size={13} /> 还原到这一刻
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}