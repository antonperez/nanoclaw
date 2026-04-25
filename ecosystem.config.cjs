module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: '/home/anton/nanoclaw/dist/index.js',
      cwd: '/home/anton/nanoclaw',
      interpreter: '/home/anton/.nvm/versions/node/v20.20.2/bin/node',
      out_file: '/mnt/pi/nanoclaw/logs/nanoclaw-pm2.log',
      error_file: '/mnt/pi/nanoclaw/logs/nanoclaw-pm2-error.log',
      merge_logs: true,
      log_date_format: '',
      env: {
        LOG_FILE: '/mnt/pi/nanoclaw/logs/nanoclaw.log',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    },
  ],
};
