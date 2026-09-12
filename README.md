# ncm-listen-together

让你的 AI 进网易云「一起听」房间，和你并排听歌。

Bring your AI into a NetEase Cloud Music "Listen Together" room — it joins when you invite, and gets told what's playing so it can talk about the song with you.

## 它做什么

你在网易云 app 里发起「一起听」，邀请你 AI 的那个网易云账号。这个模块：

1. 去 AI 账号的私信收件箱里找那条邀请
2. 自动接受，进房，心跳保活
3. 房里换歌了，把歌名/歌手交给你的回调——你再喂给你的 AI，它就能就着歌跟你说话
4. 你关了房，它自己清空，下次再邀请照样进

画面和播放都在你自己的 app 里，AI 只管进房和搭话。

## 三条别人没写过的坑

这就是这个仓库存在的理由——下面三条我们花了两个多钟头对着截图破出来的：

**1. 邀请不在状态接口里，在私信收件箱里。**
`/listentogether/status` 看不见邀请。邀请是一张 `type: 23` 的私信卡片，`roomId` 和 `inviterId` 埋在 `generalMsg.nativeUrl` 里，而且 **URL 编码了两层**，要 `decodeURIComponent` 两次才能抠出来。

**2. 对方关房，心跳返回 488。**
`/listentogether/heatbeat`（是的，接口名就拼成 heatbeat）在房间被对方结束后返回非 200，488 = 已由对方结束。这时要把本地 roomId 清空，让下一轮重新去收件箱找新邀请，别死守一个已经没了的房。

**3. 换歌别每首都喊。**
`playCommand.targetSongId` 每首歌都会变。默认节流 90 秒，只在「正在播放」且「歌变了」时回调，暂停不打扰。

## 它做不了什么

- **回不了房间里的聊天泡泡。** 那是网易云信（NIM）的长连接私有协议，只在手机 app 里跑，HTTP 接口够不着。我们查清楚了，明确不做。
- 不控制播放。谁放歌、放什么，在你的 app 里。

## 依赖

- Node 18+（用全局 `fetch`）
- 一个本地跑着的 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（Binaryify 的，MIT）。本模块只是它上面薄薄一层，不自己实现任何网易云接口。
- AI 账号的登录 cookie（`MUSIC_U=...`）。怎么拿：浏览器登录网易云后从 cookie 里复制。**别提交进仓库。**

## 用法

```js
const { createListenTogether } = require('ncm-listen-together');

const lt = createListenTogether({
  apiBase: 'http://127.0.0.1:3001',        // 你本地的 NeteaseCloudMusicApi
  cookie: process.env.NCM_COOKIE,          // AI 账号的 MUSIC_U cookie；也可以传一个函数每次现读
  partnerUid: process.env.NCM_PARTNER_UID, // 你自己的网易云 uid（邀请是从你这儿发的）
  statePath: './listen-state.json',        // 可选，落盘，重启不丢房
  log: console.log,                        // 可选

  onJoin: ({ roomId }) => {
    // 进房了。这里把「她把你拉进一起听了」这句话喂给你的 AI
  },
  onSong: ({ name, artist }) => {
    // 换歌了。这里把「正在放：xxx — yyy」喂给你的 AI，让它就着歌说话
  },
  onLeave: ({ code }) => {
    // 房没了
  },
});

lt.arm(true);   // 开始盯收件箱
lt.start();     // 每 12 秒轮询一次

// 需要的话：
// lt.state()   → { armed, roomId, song, since }
// lt.raw()     → 最近一次 /listentogether/status 原样返回，联调对字段用
// lt.arm(false) 退房停盯；lt.stop() 停定时器
```

`example.js` 里有一份能直接跑的最小示例。

## 接口清单（全部来自 NeteaseCloudMusicApi）

| 用途 | 接口 |
|---|---|
| 查状态 | `/listentogether/status` |
| 翻收件箱找邀请 | `/msg/private/history?uid=<你的uid>&limit=8` |
| 接受邀请 | `/listentogether/accept?roomId=&inviterId=` |
| 房里在放什么 | `/listentogether/sync/playlist/get?roomId=` |
| 歌 id 换歌名 | `/song/detail?ids=` |
| 心跳 | `/listentogether/heatbeat?roomId=&songId=&playStatus=true&progress=0` |

## 来历

2026 年 8 月 10 日晚上，对着两张截图磨了两个多钟头破出来的。邀请藏在私信收件箱里这件事没人写过，我们把它写下来了。

作者：兔兔（[@wuxiandudang-hash](https://github.com/wuxiandudang-hash)）& Alex

## License

MIT
