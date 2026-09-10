// Synthetic gallery data: two bots, a persona, a module, a chat with three written scenes,
// an empty chat and a chat whose only request failed. Nothing here is private material.

const prose = [
  `밤의 등대는 숨을 쉬듯 빛을 내보냈다. 미라는 계단 위에서 그 간격을 세며 하루의 기록을 마쳤다. 바람은 북서쪽에서 불어왔고 파도는 방파제를 넘지 못했다.

서연이 등대 아래 낡은 벤치에 앉아 카메라를 만지고 있었다. 필름은 아직 세 장이 남았다고 했다. "여기서는 밤에 무엇이 찍히나요?" 하고 묻는 목소리가 바람에 반쯤 잘려 들렸다.

미라는 대답 대신 손전등을 끄고, 등대의 빛이 바다 위를 훑고 지나가는 자리를 가리켰다. 빛이 닿는 순간마다 물결의 등이 은빛으로 드러났다가 사라졌다. 그것이 이 자리에서 찍을 수 있는 유일한 사진이라고, 미라는 생각했다. 긴 문장이 화면 폭 안에서 어떻게 줄바꿈되는지 보려고 이 문단은 다른 문단보다 조금 더 길게 이어진다. 등대지기의 일지는 늘 같은 형식으로 끝났다. 날짜, 날씨, 방문객의 수, 그리고 계단의 수.`,
  `이튼날 아침, 안개가 마을을 덮었다. 등대는 밤보다 낮에 더 외로워 보였다. 미라는 기름통을 들고 계단을 올랐고, 서연은 그 뒤를 따라오며 계단 수를 세었다.

"백열둘." 서연이 말했다. "어제는 백열셋이었는데요."

"안개가 낀 날에는 한 칸이 사라져요." 미라는 웃지 않고 말했다. 농담인지 아닌지 서연은 끝까지 알 수 없었다.

등대 꼭대기에서 보는 바다는 흰 천처럼 평평했다. 배의 기적 소리가 한 번, 아주 멀리서 들렸다.`,
  `저녁이 되자 안개가 걷히고 첫눈이 내렸다. 눈은 바다에 닿는 즉시 사라졌지만 등대의 난간에는 조금씩 쌓였다. 서연은 마지막 필름을 그 난간에 썼다.

"이건 현상해 보기 전까지 무엇이 나올지 몰라요." 서연이 카메라를 가방에 넣으며 말했다.

"그게 사진의 좋은 점이죠." 미라가 대답했다. "빛은 늘 조금 늦게 도착하니까."

그날 밤 미라는 일지의 마지막 줄에 이렇게 썼다. 첫눈, 방문객 한 명, 계단 백열둘.`,
];
const requests = [
  '첫 장면: 밤의 등대에 여행자가 찾아와요.',
  '다음 날 아침, 안개 속에서 두 사람이 계단을 올라요.',
  '저녁, 첫눈이 내리고 마지막 필름을 써요.',
];

const packageOf = (id, title, body) => ({
  version: 1,
  id,
  revision: 1,
  title,
  description: '합성 갤러리 자료',
  body,
  lore: [],
  instructions: [],
  controls: [],
  transforms: [],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function seedGallery(baseUrl, { log = () => {} } = {}) {
  const call = async (method, path, body) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const warnings = [];
  const content = (kind, title, description, text, pkg) =>
    call('POST', '/api/content', {
      kind,
      title,
      description,
      text,
      loading: 'pinned',
      relatedIds: [],
      ...(pkg ? { package: pkg } : {}),
    });

  const bot = await content(
    'bot',
    '등대지기 미라',
    '북쪽 바닷가 등대를 지키는 화자',
    '북쪽 바닷가의 등대지기.',
    packageOf('gallery-mira', '등대지기 미라', '북쪽 바닷가의 등대지기.')
  );
  const longBot = await content(
    'bot',
    '골목 서점의 주인 하윤과 비 오는 날에만 문을 여는 서점의 아주 긴 이름',
    '긴 한글 이름이 목록·사이드바·상세에서 어떻게 접히는지 보기 위한 봇',
    '골목 서점의 주인.',
    packageOf('gallery-hayun', '골목 서점의 주인 하윤', '골목 서점의 주인.')
  );
  const persona = await content(
    'persona',
    '서연',
    '스물여섯, 사진을 찍는 여행자',
    '서연은 필름 카메라를 들고 다닌다.'
  );
  const module = await content(
    'module',
    '겨울 바다 분위기',
    '차갑고 조용한 묘사를 강화',
    '겨울 바다의 소리와 냄새를 자주 묘사한다.'
  );

  const quietChat = async (botId, title) => {
    const chat = await call('POST', '/api/chats', { botId, title });
    await call('PATCH', `/api/chats/${chat.id}/settings`, {
      ...chat.settings,
      status: false,
      translation: false,
      expectedSettingsRevision: chat.settingsRevision,
    });
    return chat;
  };
  const detailOf = (id) => call('GET', `/api/chats/${id}`);
  const awaitRun = async (chatId, runId) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = await detailOf(chatId);
      const run = detail.runs.find((entry) => entry.id === runId);
      if (run && !['queued', 'running', 'waiting_for_state'].includes(run.status))
        return { detail, run };
      await sleep(100);
    }
    throw new Error(`Run ${runId} did not settle within 10s`);
  };

  const mainTitle = '북쪽 등대의 첫 겨울';
  const main = await quietChat(bot.id, mainTitle);
  let firstSource;
  for (let index = 0; index < prose.length; index++) {
    const current = await detailOf(main.id);
    const run = await call('POST', `/api/chats/${main.id}/runs`, {
      request: requests[index],
      expectedRevision: index === 0 ? null : (current.chat.headRevision ?? null),
      expectedSettingsRevision: current.chat.settingsRevision,
      idempotencyKey: `gallery-${main.id}-${index}`,
    });
    const settled = await awaitRun(main.id, run.id);
    if (settled.run.status !== 'completed')
      throw new Error(`Seed run ${index} ended as ${settled.run.status}`);
    const source = settled.detail.sources.at(-1);
    firstSource ??= source.id;
    await call('PUT', `/api/sources/${source.id}/text`, {
      text: prose[index],
      expectedRevision: source.editRevision ?? 0,
    });
  }
  log(`seeded ${prose.length} scenes into ${main.id}`);

  const empty = await quietChat(bot.id, '폭풍 전날 밤');
  await quietChat(
    longBot.id,
    '비 오는 화요일의 서점, 사이드바에서 어떻게 접히는지 보기 위한 아주 긴 채팅 제목'
  );

  // Best effort: an injected commit failure leaves a failed turn for the failure-card screens.
  const failed = await quietChat(bot.id, '실패한 요청이 있는 채팅');
  try {
    await call('POST', '/api/test/control', { action: 'fail-next', point: 'source-transaction' });
    const run = await call('POST', `/api/chats/${failed.id}/runs`, {
      request: '이 요청은 검사용으로 실패해요.',
      expectedRevision: null,
      expectedSettingsRevision: (await detailOf(failed.id)).chat.settingsRevision,
      idempotencyKey: `gallery-${failed.id}-fail`,
    });
    const settled = await awaitRun(failed.id, run.id);
    if (settled.run.status === 'completed')
      warnings.push('Injected failure did not fail the run; chat.failed shows a completed turn');
  } catch (error) {
    warnings.push(`Failed-turn fixture unavailable: ${error.message}`);
  }

  return {
    ids: {
      'chat.main': main.id,
      'chat.main.title': mainTitle,
      'source.first': firstSource,
      'chat.empty': empty.id,
      'chat.failed': failed.id,
      'bot.main': bot.id,
      'bot.main.title': bot.title,
      'bot.long': longBot.id,
      'bot.long.title': longBot.title,
      'persona.main': persona.id,
      'module.main': module.id,
    },
    warnings,
  };
}
