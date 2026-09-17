module.exports = {
apps: [
    {
      name: "wa-a",
      script: "baileys/src/main.js",
      env: {
        PORT: 3021,
        SESSION_ID: "a",
        http_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        https_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTP_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTPS_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
      },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      cron_restart: "0 3 * * *",
      log_file: "./logs/combined.log",
      time: true
    },
 {
      name: "wa-b",
      script: "baileys/src/main.js",
      env: {
        PORT: 3022,
        SESSION_ID: "b",
        http_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        https_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTP_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTPS_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      cron_restart: "0 3 * * *",
      log_file: "./logs/combined.log",
      time: true
    },
{
      name: "bot",
      script: "baileys/src/main.js",
      env: {
        PORT: 3005,
        SESSION_ID: "bot",
        http_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        https_proxy: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTP_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        HTTPS_PROXY: "http://efeuli0:Eliseo2003@proxyespecial.svc.rosario.gov.ar:3128",
        },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      cron_restart: "0 3 * * *",
      log_file: "./logs/combined.log",
      time: true
    }

]
};
