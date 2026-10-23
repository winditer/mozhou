import { useState, type ReactNode } from 'react'
import { AlertTriangle, Copy, Download, Upload } from 'lucide-react'
import { Button, Spinner } from '../../components/ui'
import { mz } from '../../lib/bridge'
import { useApp } from '../../store/app'
import { formatNumber } from '@shared/utils'
import { ConfirmModal, errMsg, PageHead, MONO } from './common'

export function DataSection(): ReactNode {
  const appInfo = useApp((s) => s.appInfo)
  const refreshProjects = useApp((s) => s.refreshProjects)
  const toast = useApp((s) => s.toast)
  const project = useApp((s) => s.project)
  const projects = useApp((s) => s.projects)

  const [exporting, setExporting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [wipeOpen, setWipeOpen] = useState(false)

  const userData = appInfo?.userData ?? ''
  const totalWords = project ? project.chapters.reduce((sum, c) => sum + (c.words || 0), 0) : 0
  const snapshotCount = project ? project.chapters.reduce((sum, c) => sum + (c.versions?.length ?? 0), 0) : 0

  async function copyPath(): Promise<void> {
    if (!userData) return
    try {
      await navigator.clipboard.writeText(userData)
      toast('数据目录已复制', 'ok')
    } catch (e) {
      toast(`复制失败：${errMsg(e)}`, 'error')
    }
  }

  async function handleExport(): Promise<void> {
    setExporting(true)
    try {
      const res = await mz.project.backupAll()
      if (res.canceled) toast('已取消导出', 'info')
      else toast(res.path ? `备份已导出到 ${res.path}` : '备份已导出', 'ok')
    } catch (e) {
      toast(`导出失败：${errMsg(e)}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  async function handleRestore(): Promise<void> {
    setRestoring(true)
    try {
      const res = await mz.project.restoreAll()
      if (res.ok) {
        toast(`已还原 ${res.count ?? 0} 部作品`, 'ok')
        try {
          await refreshProjects()
        } catch {
          /* 列表刷新失败不致命 */
        }
      } else {
        toast(res.message ?? '还原失败', 'error')
      }
    } catch (e) {
      toast(`还原失败：${errMsg(e)}`, 'error')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div>
      <PageHead title="数据与备份" desc="所有稿件、设定与配置都存在你这台电脑上，墨舟没有云端账户，也不会上传任何内容。" />

      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-2">数据存放位置</div>
        <div className="flex items-center gap-2">
          <div
            className="flex-1 min-w-0 truncate rounded-md px-2.5 py-2 text-[11.5px] selectable"
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', fontFamily: MONO }}
            title={userData}
          >
            {userData || '（未知）'}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void copyPath()} disabled={!userData}>
            <Copy size={13} /> 复制路径
          </Button>
        </div>
        <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          作品是纯 JSON 文件，可以直接用文本编辑器打开或拷到 U 盘。API Key 单独存在系统钥匙串里，不在此目录中。
        </div>
      </div>

      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-2">你的稿子现在有几份</div>
        <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-faint)' }}>
          墨舟不替你备份到云端，所以「有几份稿、在哪」必须让你一眼看见。下面这些都在你这台电脑上。
        </div>
        <div className="space-y-1.5">
          <BackupRow
            label="当前稿"
            detail={projects.length ? `${projects.length} 部作品 · 共 ${formatNumber(totalWords)} 字` : '还没有作品'}
            ok={projects.length > 0}
          />
          <BackupRow
            label="每章历史快照"
            detail={
              snapshotCount > 0
                ? `${snapshotCount} 个版本（每章最多 20 个，改动前自动留）`
                : '还没有快照（改动正文后会开始记录）'
            }
            ok={snapshotCount > 0}
          />
          <BackupRow
            label="磁盘上的 .bak"
            detail="每次保存都会把上一版覆盖为 .bak，主文件损坏时自动回退"
            ok
          />
          <BackupRow
            label="你导出的备份文件"
            detail="需要手动「导出完整备份」并自己存到网盘或移动硬盘——这份只在你自己手里"
            ok={false}
          />
        </div>
      </div>

      <div className="card p-4 mb-4">
        <div className="text-[13px] font-medium mb-1">完整备份</div>
        <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-faint)' }}>
          导出会把所有作品打包成一个 .mzbak 文件（含大地图外的全部内容）；还原不会覆盖已有作品，只会新增。
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? <Spinner size={12} /> : <Download size={13} />}
            {exporting ? '导出中…' : '导出完整备份'}
          </Button>
          <Button size="sm" onClick={() => void handleRestore()} disabled={restoring}>
            {restoring ? <Spinner size={12} /> : <Upload size={13} />}
            {restoring ? '还原中…' : '从备份还原'}
          </Button>
        </div>
      </div>

      <div className="text-[11.5px] leading-relaxed mb-4 px-1" style={{ color: 'var(--text-faint)' }}>
        墨舟不上传你的稿件：所有 AI 请求都由本机直连你在「渠道与模型」里配置的接口，正文只在生成那一刻发给该服务商。
      </div>

      <div className="card p-4" style={{ borderColor: 'color-mix(in srgb, var(--danger) 32%, var(--border))' }}>
        <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={14} />
          危险操作
        </div>
        <div className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--text-faint)' }}>
          删除数据不可恢复。为保证不误删你的稿件，墨舟不提供一键清空，请手动处理。
        </div>
        <Button size="sm" variant="danger" onClick={() => setWipeOpen(true)}>
          清空所有本地数据
        </Button>
      </div>

      <ConfirmModal
        open={wipeOpen}
        title="清空所有本地数据"
        danger
        confirmText="我知道了"
        message={
          <span>
            为避免误删，墨舟不会自动删除任何文件。如确实要清空，请关闭应用后在访达中手动删除以下目录：
            <br />
            <span className="selectable" style={{ fontFamily: MONO, fontSize: 11.5, wordBreak: 'break-all' }}>
              {userData || '（未知路径）'}
            </span>
            <br />
            删除前建议先「导出完整备份」。
          </span>
        }
        onClose={() => setWipeOpen(false)}
        onConfirm={() => {
          setWipeOpen(false)
          toast(userData ? `请前往访达手动删除：${userData}` : '请前往访达手动删除数据目录', 'info')
        }}
      />
    </div>
  )
}

function BackupRow({ label, detail, ok }: { label: string; detail: string; ok: boolean }): ReactNode {
  return (
    <div className="flex items-start gap-2 py-1.5" style={{ borderTop: '1px solid var(--border)' }}>
      <span
        className="mt-1 shrink-0 rounded-full"
        style={{ width: 6, height: 6, background: ok ? 'var(--ok)' : 'var(--warn)' }}
      />
      <div className="min-w-0">
        <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {label}
        </div>
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          {detail}
        </div>
      </div>
    </div>
  )
}
