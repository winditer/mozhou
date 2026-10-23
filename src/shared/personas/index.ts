import type { StylePersona } from '../styleLibrary'

/**
 * 系统文风分身库：6 大流派，共 100 位作者。
 *
 * 设计取舍（与产品确认过）：
 * - **不内置原文样本**。样本是 few-shot 注入的核心，但引入名家原文有版权风险，
 *   且体积会膨胀到 MB 级。这里只给「可执行特征卡 + 风格摘要」，
 *   用户想要更像，可以自己往分身里补样本（书内或设置页都支持）。
 * - 特征卡必须能被写作者照做、被编辑逐条核对，禁止「文笔优美」这类空话——
 *   它们会原样进入 system prompt，空话只会让模型更散。
 * - `builtin: true` 的分身是首次启动时写入用户数据目录的种子，
 *   之后用户可以自由改、删、加；升级不会覆盖用户的改动（见 main/storage/styleLibrary.ts）。
 */
import { CLASSICS_PERSONAS } from './classics'
import { ROMANCE_PERSONAS } from './romance'
import { HISTORY_PERSONAS } from './history'

export const SEED_PERSONAS: StylePersona[] = [...CLASSICS_PERSONAS, ...ROMANCE_PERSONAS, ...HISTORY_PERSONAS]

/** 种子库的版本号：改数据结构或增删种子时 +1，主进程据此决定是否补种 */
export const SEED_VERSION = 2