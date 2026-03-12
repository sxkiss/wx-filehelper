<!-- AUTO-DOC: Update me when project structure or architecture changes -->

# Wx FileHelper Architecture

wx-filehelper 采用两层结构：`src/channel.ts` 负责与 wx-filehelper-api 交互（登录检查、轮询、媒体物化、文本发送、媒体 multipart 上传发送），`src/index.ts` 负责 OpenClaw 插件编排（账号生命周期、入站分发、出站投递、目录解析）。入站链路为 `/login/status` -> `/bot/getUpdates` -> 消息标准化 -> session/dispatcher；出站链路支持文本 `sendMessage` 与媒体 `/bot/sendPhoto/upload`、`/bot/sendDocument/upload`。

- Root index: `INDEX.md`
- Source index: `src/INDEX.md`
