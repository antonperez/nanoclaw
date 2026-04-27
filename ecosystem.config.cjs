module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: '/home/anton/nanoclaw/dist/index.js',
      cwd: '/home/anton/nanoclaw',
      interpreter: '/home/anton/.nvm/versions/node/v20.20.2/bin/node',
      out_file: '/mnt/pi/nanoclaw/logs/nanoclaw.log',
      error_file: '/mnt/pi/nanoclaw/logs/nanoclaw-error.log',
      merge_logs: true,
      log_date_format: '',
      env: {
        LOG_FILE: '/mnt/pi/nanoclaw/logs/nanoclaw.log',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    },
    {
      name: 'nanoclaw-mcp',
      script: '/home/anton/nanoclaw/mcp-server/dist/index.js',
      cwd: '/home/anton/nanoclaw/mcp-server',
      interpreter: '/home/anton/.nvm/versions/node/v20.20.2/bin/node',
      out_file: '/mnt/pi/nanoclaw/logs/nanoclaw-mcp-out.log',
      error_file: '/mnt/pi/nanoclaw/logs/nanoclaw-mcp-error.log',
      merge_logs: true,
      log_date_format: '',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    },
  ],
};
