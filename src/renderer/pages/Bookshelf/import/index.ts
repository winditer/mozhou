/**
 * 书稿导入 · 纯逻辑出口
 *
 * 单独出一个 barrel 是为了测试：scripts/test-import-book.mjs 只需打包这一个入口，
 * 就能拿到解析/容错/装配的全部可测函数，不必知道它们散在哪几个文件里。
 * 这里刻意不 import React —— 界面组件 ImportBookWizard.tsx 在上一层。
 */
export {
  parseImportText,
  titleFromFileName,
  authorFromFileName,
  detectHead,
  matchVolumeMarker,
  matchChapterMarker,
  stripChapterNumber,
  type ImportChapter,
  type ImportParseResult,
  type ImportSplitMode,
  type ImportVolume
} from './parse'

export {
  EMPTY_META,
  batchChapters,
  chapterSummaryMessages,
  genreListForPrompt,
  messagesChars,
  metaMessages,
  normalizeGenreId,
  parseChapterSummaries,
  parseMetaOutput,
  parseVolumePlanOutput,
  planVolumeAssignments,
  sampleForMeta,
  volumePlanMessages,
  type ChapterSummary,
  type ImportMeta,
  type ImportMetaCharacter,
  type SummaryBatch,
  type VolumePlanItem
} from './aiParse'

export {
  IMPORT_SCENE_ID,
  assembleImportedProject,
  type ImportDraftChapter,
  type ImportDraftVolume,
  type ImportProduct
} from './assemble'