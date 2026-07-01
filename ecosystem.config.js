// PM2 設定: KPIEE オンボーディング AI のサーバー(API:8787)とフロント(Vite:5173)。
// PM2 デーモンが両プロセスを管理し、クラッシュ時は自動再起動。端末/セッションに依存せず常駐する。
// 起動:   pm2 start ecosystem.config.js
// 保存:   pm2 save           (現在のプロセス一覧を保存し、起動時に復元)
// 状態:   pm2 status / pm2 logs
//
// Windows では npm 経由が不安定なため、tsx / vite の JS エントリを node で直接起動する。
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'kpiee-onboarding-server',
      cwd: path.join(root, 'server'),
      script: path.join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      args: 'src/index.ts', // .env は cwd(server) から読み込まれる
      windowsHide: true,
      autorestart: true,
      out_file: path.join(root, 'logs', 'pm2-server-out.log'),
      error_file: path.join(root, 'logs', 'pm2-server-err.log'),
    },
    {
      name: 'kpiee-onboarding-web',
      cwd: path.join(root, 'web'),
      script: path.join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js'),
      windowsHide: true,
      autorestart: true,
      out_file: path.join(root, 'logs', 'pm2-web-out.log'),
      error_file: path.join(root, 'logs', 'pm2-web-err.log'),
    },
  ],
};
