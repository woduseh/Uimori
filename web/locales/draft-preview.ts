export const messages = {
  'draftPreview.title': {
    ko: '저장 전 미리보기',
    en: 'Unsaved preview',
    ja: '保存前のプレビュー',
    zh: '保存前预览',
  },
  'draftPreview.updating': {
    ko: '갱신 중',
    en: 'Updating',
    ja: '更新中',
    zh: '正在更新',
  },
  'draftPreview.show': {
    ko: '미리보기 표시',
    en: 'Show preview',
    ja: 'プレビューを表示',
    zh: '显示预览',
  },
  'draftPreview.mode': {
    ko: '첫 메시지 보기 방식',
    en: 'First message view',
    ja: '最初のメッセージの表示',
    zh: '开场消息视图',
  },
  'draftPreview.issueAsset': {
    ko: '{name} 에셋을 찾지 못해 표시하지 않았어요.',
    en: 'Asset {name} was not found, so it is not shown.',
    ja: 'アセット {name} が見つからないため表示していません。',
    zh: '未找到素材 {name}，因此未显示。',
  },
  'draftPreview.issueRegex': {
    ko: '{number, number}번째 정규식을 적용하지 못했어요.',
    en: 'Regex {number, number} could not be applied.',
    ja: '{number, number}番目の正規表現を適用できませんでした。',
    zh: '无法应用第 {number, number} 个正则表达式。',
  },
  'draftPreview.issueRegexCommand': {
    ko: '{number, number}번째 정규식의 @@ 명령은 미리보기에서 실행하지 않아요.',
    en: 'The @@ command in regex {number, number} does not run in the preview.',
    ja: '{number, number}番目の正規表現の @@ コマンドはプレビューでは実行しません。',
    zh: '第 {number, number} 个正则表达式中的 @@ 命令不会在预览中运行。',
  },
  'draftPreview.issueFunction': {
    ko: '{name} 함수는 미리보기에서 지원하지 않아 건너뛰었어요.',
    en: 'The {name} function is not supported in the preview and was skipped.',
    ja: '{name} 関数はプレビューでは対応していないため省略しました。',
    zh: '预览不支持 {name} 函数，已跳过。',
  },
} as const;
