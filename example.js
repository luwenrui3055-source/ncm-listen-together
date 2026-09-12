// 最小示例：进房、换歌都打到控制台。
// 跑之前：本地起一个 NeteaseCloudMusicApi，然后
//   NCM_COOKIE='MUSIC_U=...' NCM_PARTNER_UID=你的uid node example.js
const { createListenTogether } = require('./index');

const lt = createListenTogether({
  apiBase: process.env.NCM_API || 'http://127.0.0.1:3001',
  cookie: process.env.NCM_COOKIE,
  partnerUid: process.env.NCM_PARTNER_UID,
  statePath: './listen-state.json',
  log: (m) => console.log('[listen]', m),
  onJoin: ({ roomId }) => console.log('进房了', roomId),
  onSong: ({ name, artist }) => console.log('正在放：', name, '—', artist),
  onLeave: ({ code }) => console.log('房没了', code),
});

lt.arm(true);
lt.start();
console.log('盯着收件箱了。去网易云 app 里发起「一起听」，邀请这个账号。');
