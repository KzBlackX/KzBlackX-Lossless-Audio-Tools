# 端到端测试

两个无头 Chromium，用虚拟麦克风互相说话。会检查：

- 双方用服务器密码登录，在空房间页点两次同一房间进入，各自看到 1 个对端；
- `inbound-rtp` 码率 > 10 kbps（音频真的到了）；
- 文字聊天到达对端；
- 静音后对端收到的码率下降（静音包）；
- FLAC 无损旁路：一端发送，另一端 `decodeAudioData` 解码出分片；
- 房间内上传文件，两端都出现文件卡片，下载内容一致；
- 桌面共享通过 WebRTC 视频轨发送，观看端能收到并解码画面；
- 一方离开后对端收到 `peer-left`；
- 点「离开房间」回到登录页并关闭 WebSocket。

## 准备

```bash
cd test
npm install
npx playwright install chromium
```

Linux 上如果 Chromium 缺少系统库，用 `npx playwright install --with-deps chromium`（需要 root）。

## 运行

先启动一个测试服务器：

```bash
../dist/kzblackx-audio-linux-amd64 --addr 127.0.0.1:8080 --password test123 --rooms 大厅,游戏 --files-dir /tmp/kzbx-files
```

然后：

```bash
QY_BASE=http://127.0.0.1:8080 QY_PASSWORD=test123 node e2e.mjs
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `QY_BASE` | `http://127.0.0.1:8080` | 服务器地址（必须 HTTPS 或 localhost） |
| `QY_PASSWORD` | 空 | 有密码的服务器 |
| `QY_ROOM` | `大厅` | 测试房间 |
| `QY_HEADFUL` | `0` | 设为 `1` 可看到浏览器窗口 |

## 注意

- 测试用的是 Chromium 的虚拟麦克风（默认是提示音），不需要真实声卡。
- 需要服务器允许 UDP 3478 的本机回环；默认配置即可。
- 如果服务器配置了 `QY_PUBLIC_IP` 指向公网，本机测试可能连不上，请用不带 `--public-ip` 的实例。
