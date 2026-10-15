const { spawn } = require('node:child_process');

if (String(process.env.CUSTOM_GAME_ONLY || '').toLowerCase() === 'true') {
  require('./custom-server');
} else {
  const child = spawn(process.execPath, [require.resolve('./server.js')], {
    stdio: 'inherit',
    env: process.env
  });
  const forward = signal => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  child.on('exit', code => process.exit(code ?? 1));
}
