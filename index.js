'use strict';
/**
 * ncm-listen-together
 * 让你的 AI 进网易云「一起听」房间，和你并排听歌。
 *
 * 它只做三件事：
 *   1. 去你的私信收件箱里找「一起听」邀请（邀请不走状态接口，藏在一张 type:23 的私信卡片里）
 *   2. 自动接受、进房、心跳保活；房被对方关了（488）就清空重找
 *   3. 房里换歌了 → 把歌名/歌手交给你的回调，你再喂给你的 AI
 *
 * 它不做的：画面、播放、房间聊天泡泡（那是网易云信 NIM 的私有协议，HTTP 够不着）。
 *
 * 依赖一个本地跑着的 NeteaseCloudMusicApi（Binaryify），本模块只是它上面薄薄一层。
 * Node 18+（用全局 fetch）。
 */

const fs = require('fs');

const DEFAULTS = {
  pollMs: 12000,            // 多久轮询一次
  songThrottleMs: 90000,    // 换歌回调最短间隔——别让 AI 每首都话痨
  inviteMaxAgeMs: 5 * 60000,// 只认多久以内的邀请，旧的作废
  inboxLimit: 8,            // 翻收件箱最近几条
  statePath: null,          // 可选：把 roomId/song 落盘，重启不丢
  log: () => {},            // 可选：日志函数
};

function createListenTogether(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  for (const k of ['apiBase', 'cookie', 'partnerUid']) {
    if (!o[k]) throw new Error(`ncm-listen-together: 缺 ${k}`);
  }
  const apiBase = String(o.apiBase).replace(/\/$/, '');
  const partnerUid = String(o.partnerUid);
  const log = o.log;

  let state = { armed: false, roomId: null, song: null, since: 0, lastSongAt: 0, lastRaw: null };
  if (o.statePath) {
    try { Object.assign(state, JSON.parse(fs.readFileSync(o.statePath, 'utf8'))); } catch {}
  }
  function save() {
    if (!o.statePath) return;
    try { fs.writeFileSync(o.statePath, JSON.stringify(state, null, 1)); } catch {}
  }

  async function api(pathAndQuery) {
    const ck = encodeURIComponent(typeof o.cookie === 'function' ? o.cookie() : o.cookie);
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const r = await fetch(apiBase + pathAndQuery + sep + 'cookie=' + ck + '&timestamp=' + Date.now());
    return r.json();
  }

  // 从收件箱里刨邀请：type:23 卡片，roomId 和 inviterId 埋在 generalMsg.nativeUrl 里，URL 编码了两层。
  // 只认结构，不读正文。
  async function findInvite() {
    const hist = await api(`/msg/private/history?uid=${partnerUid}&limit=${o.inboxLimit}`);
    const msgs = (hist && hist.msgs) || (hist && hist.data && hist.data.msgs) || [];
    for (const m of msgs) {
      if (Date.now() - (m.time || 0) > o.inviteMaxAgeMs) continue;
      let payload = null;
      try { payload = typeof m.msg === 'string' ? JSON.parse(m.msg) : m.msg; } catch {}
      const nu = payload && payload.generalMsg && payload.generalMsg.nativeUrl;
      if (!nu || !/listenTogether/i.test(nu)) continue;
      const dec = decodeURIComponent(decodeURIComponent(nu));
      const roomId = (dec.match(/roomId=([^&]+)/) || [])[1];
      const inviterId = (dec.match(/inviterId=([^&]+)/) || [])[1] || partnerUid;
      if (roomId) return { roomId, inviterId };
    }
    return null;
  }

  let polling = false;
  async function poll() {
    if (!state.armed || polling) return;
    polling = true;
    try {
      const st = await api('/listentogether/status');
      state.lastRaw = st;
      const data = (st && st.data) || {};
      const rInfo = data.roomInfo || null;

      // 还没进房：先翻收件箱
      if (!state.roomId) {
        let inv = null;
        try { inv = await findInvite(); } catch (e) { log('翻收件箱失败: ' + e.message); }
        if (inv) {
          const acc = await api(`/listentogether/accept?roomId=${encodeURIComponent(inv.roomId)}&inviterId=${inv.inviterId}`);
          const ri = acc && acc.data && acc.data.roomInfo;
          if (acc && acc.code === 200) {
            state.roomId = (ri && ri.roomId) || inv.roomId;   // 以接受后返回的为准
            state.since = Date.now(); save();
            log('进房 ' + state.roomId);
            if (o.onJoin) await o.onJoin({ roomId: state.roomId });
          } else {
            log('accept 返回 ' + JSON.stringify(acc).slice(0, 150));
          }
        }
      }
      // 状态接口说已在房、本地没记（比如对方直接拉进来）：认房
      if (!state.roomId && data.inRoom && rInfo && rInfo.roomId) {
        state.roomId = rInfo.roomId; state.since = Date.now(); save();
        if (o.onJoin) await o.onJoin({ roomId: state.roomId });
      }

      if (state.roomId) {
        // 当前歌在 playCommand.targetSongId，播放状态在 playStatus（PLAY/PAUSE）
        const pl = await api(`/listentogether/sync/playlist/get?roomId=${state.roomId}`);
        const cmd = pl && pl.data && pl.data.playCommand;
        if (cmd) {
          const sid = cmd.targetSongId || cmd.formerSongId;
          const playing = cmd.playStatus === 'PLAY';
          if (sid && playing && sid !== (state.song && state.song.id)) {
            let name = '未知', artist = '';
            try {
              const det = await api('/song/detail?ids=' + sid);
              const s0 = det && det.songs && det.songs[0];
              if (s0) { name = s0.name; artist = (s0.ar || s0.artists || []).map(a => a.name).join('/'); }
            } catch {}
            state.song = { id: sid, name, artist }; save();
            if (o.onSong && Date.now() - state.lastSongAt > o.songThrottleMs) {
              state.lastSongAt = Date.now();
              await o.onSong({ ...state.song, roomId: state.roomId });
            }
          }
        }
        // 心跳保活。对方关房会回非 200（488 = 已由对方结束）→ 清空，下一轮重新找邀请
        const hb = await api(`/listentogether/heatbeat?roomId=${state.roomId}&songId=${state.song ? state.song.id : '0'}&playStatus=true&progress=0`).catch(() => null);
        if (hb && hb.code && hb.code !== 200) {
          log(`房没了(${hb.code})，清空重找`);
          const gone = state.roomId;
          state.roomId = null; state.song = null; state.lastSongAt = 0; save();
          if (o.onLeave) await o.onLeave({ roomId: gone, code: hb.code });
        }
      }
    } catch (e) {
      log('poll 出错: ' + e.message);
    }
    polling = false;
  }

  let timer = null;
  return {
    /** 开始盯收件箱（arm=true）；false 则退出房间并停止 */
    arm(on = true) {
      state.armed = !!on;
      if (!state.armed) { state.roomId = null; state.song = null; }
      save();
      return state.armed;
    },
    /** 手动轮询一次 */
    poll,
    /** 定时轮询 */
    start() { if (!timer) timer = setInterval(poll, o.pollMs); return this; },
    stop() { if (timer) { clearInterval(timer); timer = null; } return this; },
    /** 当前状态 */
    state() { return { armed: state.armed, roomId: state.roomId, song: state.song, since: state.since }; },
    /** 联调用：最近一次 /listentogether/status 的原样返回 */
    raw() { return state.lastRaw; },
  };
}

module.exports = { createListenTogether };
