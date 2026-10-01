# CloudLink 5 Browser SDK 使用文档

> 本文档对应 `cl5-browser.js`。它是一套可直接在普通 HTML 页面中通过 `<script>` 使用的浏览器版 CL5 封装，不依赖 Scratch VM。

---

## 1. 快速开始

### 1.1 最小示例

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>CL5 Browser SDK Demo</title>
</head>
<body>
  <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
  <script src="./cl5-browser.js"></script>
  <script>
    const cl5 = new CL5();

    cl5.on('open', (info) => {
      console.log('CL5 已连接', info);
      console.log('我的 instanceId', cl5.getInstanceId());
    });

    cl5.on('peerConnect', (peerId) => {
      console.log(' peer 已连接', peerId);
    });

    cl5.on('broadcast', (channel, payload) => {
      console.log('收到广播', channel, payload);
    });

    cl5.on('message', (peerId, channel, payload) => {
      console.log('收到私聊', peerId, channel, payload);
    });

    cl5.on('voiceCall', (peerId) => {
      console.log('来电', peerId);
    });

    cl5.on('voiceStream', (peerId, stream, audioNodes) => {
      console.log('语音流就绪', peerId, audioNodes);
    });

    cl5.connect({
      serverUrl: 'wss://your-server/ws',
      auth: {
        mode: 'token',
        token: 'YOUR_TOKEN'
      }
    }).catch((err) => {
      console.error('连接失败', err);
    });
  </script>
</body>
</html>
```

### 1.2 三种认证模式

```js
// 1) Token 模式
cl5.connect({
  serverUrl: 'wss://your-server/ws',
  auth: { mode: 'token', token: 'YOUR_TOKEN' }
});

// 2) 用户名模式
cl5.connect({
  serverUrl: 'wss://your-server/ws',
  auth: { mode: 'name', username: 'MikeDEV' }
});

// 3) Cookie 模式
cl5.connect({
  serverUrl: 'wss://your-server/ws',
  auth: { mode: 'cookie' }
});
```

---

## 2. 核心概念

### 2.1 Signaling 与 PeerJS

- `ws`：信令 WebSocket，负责大厅、房间、玩家进出、广播通道等控制面消息。
- `peer`：基于 PeerJS 的 Peer 实例，负责点对点数据连接和语音通话。
- `connections`：当前已经建立的数据连接映射，key 为 peerId。
- `channels`：按 peer 维度的 DataChannel 缓存，用于多频道消息。

### 2.2 事件模型

`CL5` 继承自 `EventEmitter`，提供 `on` / `off` / `emit`。

常用事件：

| 事件名 | 参数 | 说明 |
| --- | --- | --- |
| `open` | `info` | 登录并初始化完成 |
| `signalingOpen` | `-` | 信令 WebSocket 已打开 |
| `signalingClose` | `-` | 信令 WebSocket 已关闭 |
| `peerOpen` | `peerId` | PeerJS 已打开 |
| `peerConnect` | `peerId` | 与某个 peer 的数据连接已建立 |
| `peerDisconnect` | `peerId` | 与某个 peer 的数据连接已断开 |
| `peerDisconnected` | `-` | PeerJS 断开 |
| `peerClosed` | `-` | PeerJS 关闭 |
| `peerError` | `message, peerId` | PeerJS 错误 |
| `broadcast` | `channel, payload` | 收到广播消息 |
| `message` | `peerId, channel, payload` | 收到私聊消息 |
| `channelOpen` | `peerId, channel` | 数据频道已打开 |
| `channelClose` | `peerId, channel` | 数据频道已关闭 |
| `channelData` | `peerId, channel, data` | 数据频道消息 |
| `voiceCall` | `peerId` | 收到来电 |
| `voiceStream` | `peerId, stream, audioNodes` | 语音流和音频节点就绪 |
| `joined` | `payload` | 加入房间 ACK |
| `hosted` | `payload` | 创建房间 ACK |
| `modeChange` | `mode` | 身份模式变更 |
| `lobbyList` | `list` | 房间列表 |
| `lobbyInfo` | `info` | 房间详情 |
| `lobbyClosed` | `-` | 房间已关闭 |
| `manageAck` | `payload` | 管理操作 ACK |
| `warning` | `payload` | 服务端警告 |
| `violation` | `payload` | 服务端违规/错误 |
| `error` | `err` | 底层错误 |

---

## 3. API 参考

### 3.1 连接与会话

| 方法 | 说明 |
| --- | --- |
| `connect({ serverUrl, auth })` | 连接信令服务器并初始化 |
| `disconnect()` | 断开信令连接 |
| `destroy()` | 销毁 SDK，清理连接和语音资源 |
| `isSignalingConnected()` | 信令 WebSocket 是否打开 |
| `isConnected()` | PeerJS 是否处于可用状态 |

### 3.2 身份与状态

| 方法 | 说明 |
| --- | --- |
| `getInstanceId()` | 获取当前 instanceId |
| `getUserId()` | 获取当前 userId |
| `getUsername()` | 获取当前用户名 |
| `getMode()` | 获取当前模式 |
| `getRelayPeer()` | 获取当前 relay peer |
| `isLobbyHost()` | 当前是否为主持人 |
| `setVerbose(level)` | 开启/关闭调试日志 |
| `setKeepalive(state, delay)` | 开启/关闭保活 |

### 3.3 Peer 管理

| 方法 | 说明 |
| --- | --- |
| `getPeers()` | 获取全部已知 peerId |
| `getAllConnectedPeers()` | 获取已连接 peerId |
| `getLastDisconnected()` | 获取最后断开的 peerId |
| `getPeerUsername(peerId)` | 获取对方用户名 |
| `getPeerAccountId(peerId)` | 获取对方账号 ID |
| `getPeerChannels(peerId)` | 获取对方已开频道列表 |
| `isPeerConnected(peerId)` | 某个 peer 是否还连接着 |
| `disconnectPeer(peerId)` | 主动断开某个 peer |

### 3.4 房间/大厅管理

| 方法 | 说明 |
| --- | --- |
| `getLobbyHost()` | 当前房间主持人 |
| `getLobbyList()` | 当前房间列表 |
| `getCachedLobbyInfo()` | 同步读取本地缓存的当前房间详情 |
| `refreshLobbies()` | 刷新房间列表 |
| `getLobbyInfo(name)` | 异步查询指定房间详情（走 FIND_LOBBY 信令，需传房间名） |
| `hostLobby(name, options)` | 创建房间 |
| `joinLobby(name, password)` | 加入房间 |
| `closeLobby()` | 关闭当前房间 |
| `setLock(locked)` | 设置房间锁定 |
| `setPlayerLimit(limit)` | 设置人数上限 |
| `setPassword(password)` | 设置密码 |
| `kick(peerId)` | 踢人 |
| `transferOwnership(peerId)` | 转让房主 |

`hostLobby` 的 `options` 支持：

- `maxPlayers`：人数上限
- `password`：密码
- `locked`：是否锁定
- `relay`：是否允许 relay

### 3.5 消息与频道

| 方法 | 说明 |
| --- | --- |
| `openChannel(peerId, channel, ordered)` | 打开指定频道 |
| `closeChannel(peerId, channel)` | 关闭指定频道 |
| `send(peerId, channel, data, wait)` | 发私聊消息 |
| `broadcast(channel, data, wait)` | 发广播消息 |
| `getChannelData(peerId, channel)` | 读某个 peer 频道缓存 |
| `getGlobalChannelData(channel)` | 读全局频道缓存 |

### 3.6 语音通话

| 方法 | 说明 |
| --- | --- |
| `requestMicrophonePermissions()` | 请求麦克风权限 |
| `hasMicrophonePermissions()` | 是否已有麦克风权限 |
| `isVoiceConnected(peerId)` | 是否正在和某个 peer 语音通话 |
| `isRinging(peerId)` | 是否正在响铃 |
| `isMicrophoneMuted(peerId)` | 麦克风是否静音 |
| `setMicrophoneMuted(peerId, muted)` | 设置静音 |
| `getLastPrivateMessagePeer()` | 最后私聊来源 peer |
| `getLastPrivateMessageChannel()` | 最后私聊频道 |
| `callPeer(peerId)` | 发起语音呼叫 |
| `answerCall(peerId)` | 接听来电 |
| `declineCall(peerId)` | 拒绝来电 |
| `hangup(peerId)` | 挂断语音 |

语音空间/音量控制：

| 方法 | 说明 |
| --- | --- |
| `getCallX(peerId)` | 获取语音 X 坐标 |
| `setCallX(peerId, x)` | 设置语音 X 坐标 |
| `changeCallX(peerId, steps)` | 修改语音 X 坐标 |
| `getCallY(peerId)` | 获取语音 Y 坐标 |
| `setCallY(peerId, y)` | 设置语音 Y 坐标 |
| `changeCallY(peerId, steps)` | 修改语音 Y 坐标 |
| `getCallZ(peerId)` | 获取语音 Z 坐标 |
| `setCallZ(peerId, z)` | 设置语音 Z 坐标 |
| `changeCallZ(peerId, steps)` | 修改语音 Z 坐标 |
| `getCallVolume(peerId)` | 获取语音音量 |
| `setCallVolume(peerId, volume)` | 设置语音音量 |
| `changeCallVolume(peerId, steps)` | 修改语音音量 |

### 3.7 端到端加密

| 方法 | 说明 |
| --- | --- |
| `generateEncryptionKeyPair()` | 生成 ECDH P-256 密钥对 |
| `hasEncryptionKeyPair()` | 是否已有密钥对 |
| `deriveSharedKey(publicKey, id)` | 和某个 peer 派生共享密钥 |
| `encryptMessage(message, id)` | 加密消息 |
| `decryptMessage(encryptedMessageBase64, ivBase64, id)` | 解密消息 |

密钥存储说明：

- `connect()` 时会自动生成密钥对（ECDH P-256），并把公钥（SPKI/base64）通过 INIT 信令发给信令服务器，服务端仅透传、不强依赖该字段。
- 私钥和派生出的共享密钥都是 **不可导出的 `CryptoKey`**（`extractable: false`），只存在于当前页面内存中，关闭页面即丢失；SDK 不会把它们序列化成 base64，任何接口也拿不到私钥明文。
- 因此 E2EE 状态不跨刷新保留：刷新页面 = 新密钥对，对端需要重新派生共享密钥。
- 浏览器版不会自动用远端 peer 的公钥派生共享密钥；需要自行取得对方公钥后调用 `deriveSharedKey(remotePublicKey, id)`，后续 `encryptMessage` / `decryptMessage` 的 `id` 必须和它一致，否则会抛 "No shared key"。

示例：

```js
// 自己生成密钥对
await cl5.generateEncryptionKeyPair();

// 拿到对方公钥后派生共享密钥
await cl5.deriveSharedKey(remotePublicKey, 'peerA');

// 加密
const [cipher, iv] = await cl5.encryptMessage('hello', 'peerA');

// 解密
const plain = await cl5.decryptMessage(cipher, iv, 'peerA');
```

### 3.8 网络化同步

浏览器版提供基于 Proxy 的列表/变量网络同步能力。

| 方法 | 说明 |
| --- | --- |
| `makeGlobalNetworkedList({ list, channel, id }, callback)` | 创建全局网络列表 |
| `makePrivateNetworkedList({ list, peer, channel, id }, callback)` | 创建私聊网络列表 |
| `makeGlobalNetworkedVar({ var, channel, id }, callback)` | 创建全局网络变量 |
| `makePrivateNetworkedVar({ var, peer, channel, id }, callback)` | 创建私聊网络变量 |

`list` / `var` 可以是任意对象，SDK 会返回一个 Proxy。Proxy 提供：

- `list.length`
- `list.items`
- `list.reset()`
- `list.set(index, value)`
- `list.replace(index, values)`
- `list.append(values)`
- `list.delete(index, count)`

变量 Proxy 提供：

- `var.value`
- `var.set(value)`
- `var.change(steps)`

示例：

```js
const sharedList = cl5.makeGlobalNetworkedList({
  list: {},
  channel: 'game',
  id: 'leaderboard'
}, (event) => {
  console.log('同步更新', event);
});

sharedList.append(['Alice', 'Bob']);
sharedList.set(0, 'Mike');

const sharedVar = cl5.makeGlobalNetworkedVar({
  var: {},
  channel: 'game',
  id: 'score'
}, (event) => {
  console.log('分数同步', event);
});

sharedVar.set(10);
sharedVar.change(5);
```

### 3.9 调试与错误

| 方法 | 说明 |
| --- | --- |
| `getClientError()` | 最近一次错误消息 |
| `getClientErrorPeer()` | 最近一次错误相关 peer |
| `setAutoReconnect(enabled)` | 开启/关闭 PeerJS 断开后自动重连 |

---

## 4. 常见示例

### 4.1 加入房间并监听玩家进出

```js
const cl5 = new CL5();

cl5.on('open', async () => {
  await cl5.joinLobby('room-1', '');
});

cl5.on('peerConnect', (peerId) => {
  console.log('加入', peerId, cl5.getPeerUsername(peerId));
});

cl5.on('peerDisconnect', (peerId) => {
  console.log('离开', peerId, cl5.getPeerUsername(peerId));
});
```

### 4.2 私聊与频道

```js
cl5.on('open', async () => {
  await cl5.openChannel('peer-123', 'game', true);
});

cl5.on('channelOpen', (peerId, channel) => {
  if (peerId === 'peer-123' && channel === 'game') {
    cl5.send('peer-123', 'game', { text: 'hello' });
  }
});

cl5.on('message', (peerId, channel, payload) => {
  console.log(peerId, channel, payload);
});
```

### 4.3 语音通话

```js
cl5.on('peerConnect', async (peerId) => {
  await cl5.requestMicrophonePermissions();
});

cl5.on('voiceCall', async (peerId) => {
  await cl5.answerCall(peerId);
  cl5.setCallVolume(peerId, 0.8);
});

document.getElementById('callBtn').onclick = async () => {
  await cl5.callPeer('peer-123');
};
```

---

## 5. 从 Scratch 版迁移到浏览器版

| Scratch 版能力 | 浏览器版对应方式 |
| --- | --- |
| 房间创建/加入/关闭/管理 | `hostLobby` / `joinLobby` / `closeLobby` / `setLock` / `kick` 等 |
| 广播/私聊 | `broadcast` / `send` |
| 频道 | `openChannel` / `closeChannel` / `getChannelData` / `getGlobalChannelData` |
| 语音通话 | `callPeer` / `answerCall` / `hangup` / `declineCall` |
| 语音状态 | `isVoiceConnected` / `isRinging` |
| 用户名/ID | `getPeerUsername` / `getPeerAccountId` |
| 网络列表/变量 | `makeGlobalNetworkedList` / `makePrivateNetworkedVar` 等 |
| E2EE | `generateEncryptionKeyPair` / `deriveSharedKey` / `encryptMessage` / `decryptMessage` |

迁移注意点：

- Scratch 版依赖 `vm.runtime` 和积木执行栈；浏览器版没有这些概念。
- Scratch 版的 `startHats` 事件，在浏览器版请直接监听 `on('open')`、`on('peerConnect')` 等事件。
- Scratch 版的 `bless` / `rebless_list` / `networkUpdateTracker` 在浏览器版中不存在，浏览器版网络同步使用独立 Proxy 实现。

---

## 6. 环境限制说明

以下能力**受限于浏览器环境或缺少 Scratch VM 宿主，无法 1:1 实现**：

- 无法直接读写 `vm.runtime.targets`。
- 无法操作 Scratch 内部变量/列表的 `bless`、`rebless`、`_monitorUpToDate`。
- 无法触发 Scratch 积木帽子，如 `startHats`。
- 无法实现 Scratch C-块、执行栈帧控制。
- 无法直接获取 Scratch 音频引擎的 `AudioContext`；浏览器版使用独立 `AudioContext`。

其余如：信令、PeerJS 数据连接、语音通话、空间音频、消息、频道、网络化同步、E2EE、自动重连、错误追踪等，均已尽量对齐浏览器环境可支持的行为。

---

## 7. 故障排查

| 问题 | 排查方向 |
| --- | --- |
| `PeerJS` 报错未加载 | 确认先加载 `peerjs`，再加载 `cl5-browser.js` |
| `connect` 失败 | 检查 `serverUrl`、网络、认证参数；查看 `error` / `signalingClose` |
| 私聊发不出去 | 确认 `isPeerConnected` 为 true，频道已 `openChannel` |
| 语音无声音 | 确认已 `requestMicrophonePermissions`，且对方已 `answerCall` |
| 加密不可用 | 确认浏览器支持 `window.crypto.subtle`；部分浏览器需要 HTTPS |
| 自动重连无效 | 确认已调用 `setAutoReconnect(true)` |

---

## 8. 版本与兼容性

- 推荐 PeerJS：`1.5.4`
- 推荐运行环境：支持 `WebSocket`、`WebRTC`、`Web Crypto API`、`AudioContext` 的现代浏览器
- 生产环境建议使用 HTTPS，避免麦克风权限和 WebRTC 受限
