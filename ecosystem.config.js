module.exports = {
  apps: [
    {
      name: "baileys",
      script: "./main.js",
      interpreter: "node",
      cwd: "/home/imusaprueba/server/baileys/src",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        SESSION_ID: "bot",
        http_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        https_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTP_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTPS_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128"
      },
      error_file: "/home/imusaprueba/.pm2/logs/baileys-error.log",
      out_file: "/home/imusaprueba/.pm2/logs/baileys-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};
