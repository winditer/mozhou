/**
 * 两段文字的最小差异区间。
 *
 * 整段加删除线对「只改了两三个字」反而更难读：作者要在一大段划掉的文字里自己找差异。
 * 所以算出真正变化的那一小段，只给它上高亮。
 *
 * 体检的「采用建议」和对话改稿的预览共用这一份——两处各写一份，highlight 的
 * 边界规则迟早会出现细微差别，同一段改动在两个弹窗里看起来不一样会很怪。
 */
export function diffSpan(before: string, after: string): { pre: string; del: string; post: string; ins: string } {
  const a = before
  const b = after
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { pre: a.slice(0, start), del: a.slice(start, endA), post: a.slice(endA), ins: b.slice(start, endB) }
}
