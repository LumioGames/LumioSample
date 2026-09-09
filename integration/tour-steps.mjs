export const TOUR_STEPS = Object.freeze([
  { id: '01', key: 'compile-config', title: '编译配表' },
  { id: '02', key: 'account-login', title: '注册登录' },
  { id: '03', key: 'start-ds', title: '起 DS' },
  { id: '04', key: 'admit-room', title: '进房间' },
  { id: '05', key: 'load-basemap', title: '加载底图' },
  { id: '06', key: 'spawn-player', title: '玩家入场' },
  { id: '07', key: 'move', title: '跑动' },
  { id: '08', key: 'chat', title: '聊天' },
  { id: '09', key: 'mine', title: '挖掘' },
  { id: '10', key: 'vein-reserve', title: '矿脉储量 -1' },
  { id: '11', key: 'cell-to-air', title: '方块变空气' },
  { id: '12', key: 'ore-drop', title: '掉出矿石' },
  { id: '13', key: 'pickup', title: '拾取' },
  { id: '14', key: 'save-restore', title: '存档重启' },
]);

export function formatStep(id, status, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  return `step=${id} status=${status}${suffix}`;
}

export function planBotLogins(bots) {
  if (!Number.isInteger(bots) || bots < 1) {
    const error = new Error('--bots must be a positive integer.');
    error.code = 'USAGE';
    throw error;
  }
  return Array.from({ length: bots }, (_, index) => `Bot${index + 1}`);
}
