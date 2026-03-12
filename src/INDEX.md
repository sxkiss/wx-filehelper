<!-- AUTO-DOC: Update me when files in this folder change -->

# src

wx-filehelper 核心实现目录，包含 API 协议层与插件编排层，覆盖文本/媒体接收发送。

## Files

| File | Role | Function |
|------|------|----------|
| channel.ts | Protocol | 多态登录状态检测、启动去重同步（兼容 `id > offset` 语义）、轮询拉取、消息标准化（含媒体提取与下载路径映射为可访问 URL）、媒体物化、文本发送、媒体 multipart 上传发送；入站媒体提取改为“当前消息媒体优先、引用媒体回退”，避免引用图覆盖当前图导致识别错图；媒体缓存目录与二维码路径统一转为绝对路径，避免模型附件加载失效 |
| index.ts | Orchestrator | 账号启动停止、会话分发（DM 使用 `direct` 共享主会话）、目录解析、outbound 发送能力；入站媒体候选先物化为本地缓存再注入媒体上下文，并用 `[media attached]` 替代原始 URL；当本地 `MediaPath` 可用时优先注入路径（不再并行注入远端 `MediaUrl`），降低模型走 URL 下载分支导致识别失败的概率 |
