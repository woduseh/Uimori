export const messages = {
  'helperConversation.measuredInput': {
    ko: '{count} 이상',
    en: 'At least {count}',
    ja: '{count}以上',
    zh: '至少 {count}',
  },
  'helperConversation.unmeasuredFiles': {
    ko: '파일 {count, number}개 미측정',
    en: '{count, plural, one {# unmeasured file} other {# unmeasured files}}',
    ja: 'ファイル{count, number}件は未計測',
    zh: '{count, number} 个文件未统计',
  },
  'helperConversation.copyCode': {
    ko: '코드 블록 {index} 복사',
    en: 'Copy code block {index}',
    ja: 'コードブロック{index}をコピー',
    zh: '复制代码块 {index}',
  },
  'helperConversation.executions': {
    ko: '{count, number}회',
    en: '{count, plural, one {# call} other {# calls}}',
    ja: '{count, number}回',
    zh: '{count, number}次',
  },
  'helperConversation.activity': {
    ko: '진행 과정',
    en: 'Progress',
    ja: '進行状況',
    zh: '进度',
  },
} as const;
