# Wx FileHelper Plugin

`wx-filehelper` 是一个基于 `wx-filehelper-api` 的 OpenClaw 通信插件，支持：
- 文本接收与发送
- 媒体接收（图片/文件/语音）并附带媒体路径提示
- 媒体发送（图片走 `sendPhoto`，其他走 `sendDocument`）

## 安装

```bash
cd /home/sxkiss/.openclaw/extensions/wx-filehelper
npm install
npm run build
```

## 配置

在 `/home/sxkiss/.openclaw/openclaw.json` 中添加：

```json
{
  "channels": {
    "wx-filehelper": {
      "enabled": true,
      "name": "Wx FileHelper",
      "baseUrl": "http://127.0.0.1:8000",
      "requestTimeout": 10000,
      "pollingTimeout": 20,
      "pollingLimit": 50,
      "pollingInterval": 1000,
      "loginAutoPoll": false,
      "loginCheckInterval": 3000,
      "qrRefreshInterval": 30000,
      "skipHistoryOnStart": true,
      "startupSyncLimit": 100,
      "qrSavePath": "media/wx-filehelper/login-qr.png",
      "mediaCacheDir": "media/wx-filehelper",
      "defaultChatId": ""
    }
  },
  "plugins": {
    "entries": {
      "wx-filehelper": {
        "enabled": true
      }
    },
    "load": {
      "paths": [
        "/home/sxkiss/.openclaw/extensions"
      ]
    }
  }
}
```

## 目标地址格式

- `wx-filehelper:user:<chatId>`
- `wx-filehelper:group:<chatId>`
- `wx-filehelper:chat:<chatId>`
- `wx-filehelper:<chatId>`

## 行为说明

1. 启动后先检查登录状态，离线时按 `qrRefreshInterval` 节流拉取二维码到 `qrSavePath`。
2. 轮询 `GET /bot/getUpdates` 获取入站消息。
3. 文本/媒体消息统一分发到 OpenClaw 会话层（session + buffered dispatcher）。
4. 回复文本通过 `POST /bot/sendMessage` 发送。
5. 回复媒体自动识别：图片走 `POST /bot/sendPhoto/upload`，其他走 `POST /bot/sendDocument/upload`。
