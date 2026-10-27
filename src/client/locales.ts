/**
 * Usage panel dictionaries, registered into the DSH locale service. The keys
 * mirror the reasonix stats locale block (settings.stats.*) plus the PR#7503
 * additions ("Other", 180-day trend note); values are the same Chinese and
 * English copy with the zh-TW variant transliterated.
 */

/** The locale namespace this plugin owns. */
export const LOCALE_NS = 'usageStats'

/** The typed translator key union for the panel's locale seat. */
export type UsageStatsKey =
  | 'nav'
  | 'back'
  | 'range'
  | 'rangePreset.today'
  | 'rangePreset.3'
  | 'rangePreset.7'
  | 'rangePreset.14'
  | 'rangePreset.30'
  | 'rangePreset.90'
  | 'rangeCustom'
  | 'from'
  | 'to'
  | 'refresh'
  | 'rebuild'
  | 'rebuildConfirm'
  | 'rebuilding'
  | 'rebuildHint'
  | 'loading'
  | 'tokens'
  | 'tokensHint'
  | 'tokensUnit'
  | 'cachedTokens'
  | 'sessions'
  | 'requests'
  | 'activeDays'
  | 'cacheRate'
  | 'cacheRateHint'
  | 'cacheHitRate'
  | 'hitRateLegend'
  | 'topModel'
  | 'topModelHint'
  | 'heatmap'
  | 'heatLess'
  | 'heatMore'
  | 'dailyTrend'
  | 'hourlyTrend'
  | 'trendLimited'
  | 'modelUsage'
  | 'providerUsage'
  | 'providerModels'
  | 'other'
  | 'total'
  | 'percent'
  | 'asOf'
  | 'empty'
  | 'estimatedCost'
  | 'estimatedCostHint'
  | 'costUnpriced'
  | 'costNone'
  | 'costBreakdown'
  | 'priceEditor'
  | 'priceEditorHint'
  | 'priceEditorOpen'
  | 'priceEditorClose'
  | 'aliasColumn'
  | 'aliasPlaceholder'
  | 'modelColumn'
  | 'inputPrice'
  | 'outputPrice'
  | 'cacheReadPrice'
  | 'cacheWritePrice'
  | 'priceUnit'
  | 'currencyLabel'
  | 'saveRow'
  | 'savingRow'
  | 'resetRow'
  | 'prefsEmpty'
  | 'prefsSearch'
  | 'seenBadge'
  | 'aliasInvalid'
  | 'legendHideHint'
  | 'legendShowHint'
  | 'legendShowAll'
  | 'cachePrecision'
  | 'cachePrecisionDesc'
  | 'tokenDetail'
  | 'tokenDetailDesc'
  | 'streamThroughput'
  | 'streamThroughputDesc'
  | 'stats.counts'
  | 'stats.tokensPerSecond'
  | 'stats.cacheHit'
  | 'stats.cacheMiss'
  | 'stats.dialog.title'
  | 'stats.dialog.usageTitle'
  | 'stats.dialog.llmTime'
  | 'stats.dialog.toolTime'
  | 'stats.dialog.ttft'
  | 'stats.dialog.speed'
  | 'message.turnUsage.count'
  | 'message.turnUsage.cacheHit'
  | 'message.turnUsage.input'
  | 'message.turnUsage.cacheRead'
  | 'message.turnUsage.cacheWrite'
  | 'message.turnUsage.output'

export const en: Record<UsageStatsKey, string> = {
  nav: 'Usage statistics',
  back: 'Back',
  range: 'Time range',
  'rangePreset.today': 'Today',
  'rangePreset.3': 'Last 3 days',
  'rangePreset.7': 'Last 7 days',
  'rangePreset.14': 'Last 14 days',
  'rangePreset.30': 'Last 30 days',
  'rangePreset.90': 'Last 90 days',
  rangeCustom: 'Custom',
  from: 'From',
  to: 'To',
  refresh: 'Refresh',
  rebuild: 'Rebuild',
  rebuildConfirm: 'Rebuild?',
  rebuilding: 'Rebuilding',
  rebuildHint: 'Rebuild the statistics from session logs: clear the local cache and replay every session. Use it when the figures look wrong.',
  loading: 'Loading',
  tokens: 'Token usage',
  tokensUnit: 'tokens',
  tokensHint: 'Provider-visible total: uncached input + output + cached tokens',
  cachedTokens: 'cached',
  sessions: 'Sessions',
  requests: 'Requests',
  activeDays: 'Active days',
  cacheRate: 'Avg cache hit rate',
  cacheRateHint: 'Cached input tokens as a share of all input tokens in the range',
  cacheHitRate: 'Cache hit rate',
  hitRateLegend: 'Cache hit rate',
  topModel: 'Top model',
  topModelHint: 'Ranked by token volume, not call count',
  heatmap: 'Activity heatmap',
  heatLess: 'Less',
  heatMore: 'More',
  dailyTrend: 'Daily token trend',
  hourlyTrend: 'Hourly token trend',
  trendLimited: 'Showing the latest {n} days',
  modelUsage: 'Model usage',
  providerUsage: 'Provider usage',
  providerModels: '{n} models',
  other: 'Other',
  total: 'Total',
  percent: 'Share',
  asOf: 'As of',
  empty: 'No usage data in this time range yet. Token usage is recorded from the day the panel is installed, including a one-time scan of your existing sessions.',
  estimatedCost: 'Estimated spend',
  estimatedCostHint: 'Tokens in the range priced with the unit prices you stored per model. Unpriced models are never charged.',
  costUnpriced: '{tokens} tokens unpriced',
  costNone: 'Set a unit price per model to estimate spend.',
  costBreakdown: 'Cost by model',
  priceEditor: 'Model aliases & prices',
  priceEditorHint: 'Short names show up everywhere a model is labelled. Unit prices (per 1M tokens) turn the token counts into an estimated spend.',
  priceEditorOpen: 'Configure',
  priceEditorClose: 'Close',
  aliasColumn: 'Short name',
  aliasPlaceholder: 'e.g. BAC-DS4.1F',
  modelColumn: 'Model',
  inputPrice: 'Input',
  outputPrice: 'Output',
  cacheReadPrice: 'Cache read',
  cacheWritePrice: 'Cache write',
  priceUnit: 'per 1M tokens',
  currencyLabel: 'Currency',
  saveRow: 'Save',
  savingRow: 'Saving',
  resetRow: 'Reset',
  prefsEmpty: 'No models yet: no model has been recorded in the usage history and none is advertised by the provider catalogue.',
  prefsSearch: 'Filter models…',
  seenBadge: 'used',
  aliasInvalid: 'Short names may not exceed 24 characters.',
  legendHideHint: 'Click to hide this model',
  legendShowHint: 'Click to show this model',
  legendShowAll: 'Show all',
  cachePrecision: 'Precise cache hit rate',
  cachePrecisionDesc: 'Show the cache hit rate with two decimals in the conversation bottom bar.',
  tokenDetail: 'Conversation token breakdown',
  tokenDetailDesc: 'Show total, cache hit/miss and output tokens in the conversation bottom bar.',
  streamThroughput: 'Streaming throughput',
  streamThroughputDesc: 'Show an estimated decode speed in the conversation bottom bar while a response streams, then the exact session figure once it settles.',
  'stats.counts': '{turns} turns · {steps} steps',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': 'Cache hit {percent}%',
  'stats.cacheMiss': 'Cache miss',
  'stats.dialog.title': 'Time & speed',
  'stats.dialog.usageTitle': 'Token usage',
  'stats.dialog.llmTime': 'LLM time',
  'stats.dialog.toolTime': 'Tool time',
  'stats.dialog.ttft': 'Mean TTFT',
  'stats.dialog.speed': 'Decode speed',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': 'Cache hit',
  'message.turnUsage.input': 'Input',
  'message.turnUsage.cacheRead': 'Cache read',
  'message.turnUsage.cacheWrite': 'Cache write',
  'message.turnUsage.output': 'Output',
}

export const zh: Record<UsageStatsKey, string> = {
  nav: '使用统计',
  back: '返回',
  range: '时间范围',
  'rangePreset.today': '今日',
  'rangePreset.3': '最近 3 天',
  'rangePreset.7': '最近 7 天',
  'rangePreset.14': '最近 14 天',
  'rangePreset.30': '最近 30 天',
  'rangePreset.90': '最近 90 天',
  rangeCustom: '自定义',
  from: '开始日期',
  to: '结束日期',
  refresh: '刷新',
  rebuild: '重建统计',
  rebuildConfirm: '确认重建？',
  rebuilding: '重建中',
  rebuildHint: '按会话日志重建统计：清空本地统计缓存并重放全部会话。数字异常时使用。',
  loading: '加载中',
  tokens: 'Tokens 用量',
  tokensUnit: 'tokens',
  tokensHint: '服务商总口径：未缓存输入 + 输出 + 缓存命中 token',
  cachedTokens: '缓存命中',
  sessions: '会话数量',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '平均缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  topModel: '最常用模型',
  topModelHint: '按 token 用量排序，非调用次数',
  heatmap: '活跃热力图',
  heatLess: '较少',
  heatMore: '较多',
  dailyTrend: '按天 Token 趋势',
  hourlyTrend: '按小时 Token 趋势',
  trendLimited: '仅显示最近 {n} 天',
  modelUsage: '模型用量',
  providerUsage: '各供应商用量',
  providerModels: '{n} 个模型',
  other: '其他',
  total: '总用量',
  percent: '占比',
  asOf: '统计截至',
  empty: '当前时间范围内暂无用量数据。Token 用量从本面板启用后开始累计，并会一次性回扫已有的历史会话。',
  estimatedCost: '预估费用',
  estimatedCostHint: '按你为各模型设置的单价，对当前时间范围内的 token 计价。未设置单价的模型不计费。',
  costUnpriced: '{tokens} tokens 未设置单价',
  costNone: '为模型设置单价后即可预估费用。',
  costBreakdown: '按模型费用',
  priceEditor: '模型简称与单价',
  priceEditorHint: '简称会替换面板中所有模型名称的显示。单价按每百万 token 填写，用于把 token 数换算成预估费用。',
  priceEditorOpen: '配置',
  priceEditorClose: '收起',
  aliasColumn: '简称',
  aliasPlaceholder: '例如 BAC-DS4.1F',
  modelColumn: '模型',
  inputPrice: '输入',
  outputPrice: '输出',
  cacheReadPrice: '缓存读',
  cacheWritePrice: '缓存写',
  priceUnit: '每百万 tokens',
  currencyLabel: '货币符号',
  saveRow: '保存',
  savingRow: '保存中',
  resetRow: '重置',
  prefsEmpty: '暂无可配置的模型：用量记录与供应商模型目录中都没有模型。',
  prefsSearch: '筛选模型…',
  seenBadge: '已用',
  aliasInvalid: '简称不能超过 24 个字符。',
  legendHideHint: '点击隐藏该模型',
  legendShowHint: '点击显示该模型',
  legendShowAll: '全部显示',
  cachePrecision: '精确缓存命中率',
  cachePrecisionDesc: '在会话底部信息栏以两位小数显示缓存命中率。',
  tokenDetail: '会话 Token 明细',
  tokenDetailDesc: '在会话底部信息栏显示总 Token、命中/未命中缓存与输出明细。',
  streamThroughput: '流式吞吐速度',
  streamThroughputDesc: '输出过程中在会话底部信息栏显示估算的解码速度，输出结束后回到会话累计的精确值。',
  'stats.counts': '{turns} 轮 · {steps} 步',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': '缓存命中 {percent}%',
  'stats.cacheMiss': '未命中缓存',
  'stats.dialog.title': '用时与速度',
  'stats.dialog.usageTitle': 'Token 用量',
  'stats.dialog.llmTime': 'LLM 用时',
  'stats.dialog.toolTime': '工具用时',
  'stats.dialog.ttft': '首 token 平均',
  'stats.dialog.speed': '解码速度',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': '缓存命中',
  'message.turnUsage.input': '输入',
  'message.turnUsage.cacheRead': '缓存读取',
  'message.turnUsage.cacheWrite': '缓存写入',
  'message.turnUsage.output': '输出',
}

export const zhTW: Record<UsageStatsKey, string> = {
  nav: '使用統計',
  back: '返回',
  range: '時間範圍',
  'rangePreset.today': '今日',
  'rangePreset.3': '最近 3 天',
  'rangePreset.7': '最近 7 天',
  'rangePreset.14': '最近 14 天',
  'rangePreset.30': '最近 30 天',
  'rangePreset.90': '最近 90 天',
  rangeCustom: '自訂',
  from: '開始日期',
  to: '結束日期',
  refresh: '重新整理',
  rebuild: '重建統計',
  rebuildConfirm: '確認重建？',
  rebuilding: '重建中',
  rebuildHint: '依會話日誌重建統計：清空本機統計快取並重放全部會話。數字異常時使用。',
  loading: '載入中',
  tokens: 'Tokens 用量',
  tokensUnit: 'tokens',
  tokensHint: '服務商總口徑：未快取輸入 + 輸出 + 快取命中 token',
  cachedTokens: '快取命中',
  sessions: '會話數量',
  requests: '請求數量',
  activeDays: '活躍天數',
  cacheRate: '平均快取命中率',
  cacheRateHint: '時間範圍內快取命中 token 佔輸入 token 的比例',
  cacheHitRate: '快取命中率',
  hitRateLegend: '快取命中率',
  topModel: '最常用模型',
  topModelHint: '依 token 用量排序，非呼叫次數',
  heatmap: '活躍熱力圖',
  heatLess: '較少',
  heatMore: '較多',
  dailyTrend: '每日 Token 趨勢',
  hourlyTrend: '每小時 Token 趨勢',
  trendLimited: '僅顯示最近 {n} 天',
  modelUsage: '模型用量',
  providerUsage: '各供應商用量',
  providerModels: '{n} 個模型',
  other: '其他',
  total: '總用量',
  percent: '佔比',
  asOf: '統計截至',
  empty: '目前時間範圍內尚無用量資料。Token 用量自本面板啟用後開始累計，並會一次掃描既有的歷史會話。',
  estimatedCost: '預估費用',
  estimatedCostHint: '依你為各模型設定的單價，對目前時間範圍內的 token 計價。未設定單價的模型不計費。',
  costUnpriced: '{tokens} tokens 未設定單價',
  costNone: '為模型設定單價後即可預估費用。',
  costBreakdown: '依模型費用',
  priceEditor: '模型簡稱與單價',
  priceEditorHint: '簡稱會取代面板中所有模型名稱的顯示。單價以每百萬 token 填寫，用於把 token 數換算成預估費用。',
  priceEditorOpen: '設定',
  priceEditorClose: '收合',
  aliasColumn: '簡稱',
  aliasPlaceholder: '例如 BAC-DS4.1F',
  modelColumn: '模型',
  inputPrice: '輸入',
  outputPrice: '輸出',
  cacheReadPrice: '快取讀',
  cacheWritePrice: '快取寫',
  priceUnit: '每百萬 tokens',
  currencyLabel: '貨幣符號',
  saveRow: '儲存',
  savingRow: '儲存中',
  resetRow: '重設',
  prefsEmpty: '尚無可設定的模型：用量記錄與供應商模型目錄中都沒有模型。',
  prefsSearch: '篩選模型…',
  seenBadge: '已用',
  aliasInvalid: '簡稱不可超過 24 個字元。',
  legendHideHint: '點擊隱藏該模型',
  legendShowHint: '點擊顯示該模型',
  legendShowAll: '全部顯示',
  cachePrecision: '精確快取命中率',
  cachePrecisionDesc: '在會話底部資訊欄以兩位小數顯示快取命中率。',
  tokenDetail: '會話 Token 明細',
  tokenDetailDesc: '在會話底部資訊欄顯示總 Token、命中/未命中快取與輸出明細。',
  streamThroughput: '串流吞吐速度',
  streamThroughputDesc: '輸出過程中在會話底部資訊欄顯示估算的解碼速度，輸出結束後回到會話累計的精確值。',
  'stats.counts': '{turns} 輪 · {steps} 步',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': '快取命中 {percent}%',
  'stats.cacheMiss': '未命中快取',
  'stats.dialog.title': '用時與速度',
  'stats.dialog.usageTitle': 'Token 用量',
  'stats.dialog.llmTime': 'LLM 用時',
  'stats.dialog.toolTime': '工具用時',
  'stats.dialog.ttft': '首 token 平均',
  'stats.dialog.speed': '解碼速度',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': '快取命中',
  'message.turnUsage.input': '輸入',
  'message.turnUsage.cacheRead': '快取讀取',
  'message.turnUsage.cacheWrite': '快取寫入',
  'message.turnUsage.output': '輸出',
}
