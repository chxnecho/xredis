# xredis

**xredis** 是一个用纯 Node.js 从零实现的 Redis 兼容服务器，唯一的依赖是
[fengari](https://github.com/fengari-lua/fengari)（纯 JS 实现的 Lua 解释器，
用于 EVAL 脚本功能）。
它实现了 RESP2/RESP3 协议、完整的内存数据结构引擎、持久化（AOF + RDB）、主从复制
（含 repl-backlog 部分重同步）、事务、发布订阅、Lua 脚本和 130+ 条 Redis 命令 ——
可以直接用官方 `redis-cli` 连接使用。

## 特性

### 协议层
- **RESP2 序列化协议**：流式增量解析器（支持 TCP 分包/粘包），内联命令，
  大 value 流式长度校验（`proto-max-bulk-len`），协议错误即断连（与 Redis 行为一致）。
- **RESP3 支持**：解析器完整接受 RESP3 类型帧（map/set/push/bool/double/typed null 等），
  `HELLO 3` 可协商切换，命令回复按连接协议版本编码；内置测试客户端同样可解码 RESP3。

### 存储引擎（`src/store/`）
- **16 个逻辑数据库**（SELECT 0..15），惰性过期 + 主动过期采样（每秒 10 次 hz 心跳）。
- **跳跃表（zskiplist.js）**：O(log n) 插入/删除/排名，支持 ZRANGEBYSCORE / ZRANGEBYLEX / ZRANK。
- **整数集合（intset.js）**：小集合自动用有序 int 数组编码，混入非整数自动升级。
- **双向链表（list.js）**：O(1) 头尾操作，LPUSH/RPUSH/LMOVE/RPOPLPUSH。
- 哈希/字符串基于 Buffer 存储，二进制安全。

### 命令集（`src/commands/`，130+ 条）
- 字符串：SET（NX/XX/GET/EX/PX/EXAT/PXAT/KEEPTTL 全选项）、GETEX、SETRANGE、
  SETBIT/GETBIT/BITCOUNT/BITPOS、INCRBYFLOAT、APPEND、MSETNX …
- 键空间：EXPIRE 家族（含 NX/XX/GT/LT 选项）、SCAN 游标遍历、COPY、RENAME、
  TYPE、OBJECT ENCODING、RANDOMKEY、TOUCH、UNLINK …
- 哈希：HSET/HGET/HINCRBYFLOAT/HSCAN/HRANDFIELD/WITHVALUES …
- 列表：LPUSH/LPOP/LRANGE/LINSERT/LTRIM/LREM/LMOVE …
- 集合：SADD/SINTER/SUNION/SDIFF（及 STORE 变体）、SRANDMEMBER、SMISMEMBER …
- 有序集合：ZADD（GT/NX/XX/CH/INCR）、ZRANGE（BYSCORE/BYLEX/REV/LIMIT）、
  ZPOPMIN/MAX、ZINTERSTORE/ZUNIONSTORE（WEIGHTS/AGGREGATE）、ZRANK、ZINCRBY …
- 连接：PING/ECHO/SELECT/AUTH/HELLO(RESP2)/CLIENT(GETID|SETNAME|LIST)/RESET
- 服务器：INFO（server/clients/memory/stats/keyspace/replication 全 section）、
  CONFIG GET/SET/REWRITE、COMMAND INFO/COUNT、TIME、DBSIZE、LASTSAVE、
  SAVE/BGSAVE、SHUTDOWN、MEMORY USAGE、DEBUG、ROLE、SLOWLOG
- 脚本：EVAL / EVALSHA / SCRIPT LOAD|EXISTS|FLUSH|KILL|DEBUG（基于 fengari 的
  内嵌 Lua 引擎，脚本内的 redis.call/redis.pcall 可直接操作键空间）

### Lua 脚本
- EVAL/EVALSHA 完整支持，脚本结果按 Redis 语义转换为 RESP 回复。
- 主从复制与 AOF 传播的是脚本本身：副本重放脚本得到相同的写入效果。

### 事务（MULTI/EXEC/DISCARD/WATCH/UNWATCH）
- 完整的乐观锁：WATCH 登记 → 写命令触碰 → EXEC 时 dirty 检查，返回 nil 数组。
- 队列中命令入队时做 arity 预检，出错即 abort（与 Redis 的 EXECABORT 语义一致）。

### 发布订阅
- 精确频道 + 通配符模式订阅（PSUBSCRIBE），PUBLISH 返回接收者数，
  订阅模式下客户端自动进入订阅应答协议（subscribe/message 帧计数）。

### 主从复制（`src/server.js`）
- `REPLICAOF host port` / 配置文件启动即成为副本；副本只读（READONLY 错误码）。
- **全量同步**：副本连接后发起内部握手，主库以 RESP 流快照回传，副本原位重放。
- **增量传播**：写命令规范化后实时推送到所有副本；跨数据库写自动插入 SELECT 帧，
  保证副本端键空间正确。随机命令（如 SPOP）传播其确定性效果（SREM），
  失败的条件写（SET NX/XX）不会被传播，保证主从一致。
- **repl-backlog**：环形积压缓冲 + 副本断线重连后的部分重同步（PSYNC CONTINUE），
  支持 WAIT 等待副本确认。
- 断线自动重连。

### 持久化（`src/persistence/`）
- **AOF**：三种 fsync 策略（always / everysec / no），命令规范化重写
  （SET 的条件/过期选项折叠成 PXAT 绝对时间），优雅退出刷盘。
- **重写（rewrite）**：将日志压缩为当前键空间的最小重建命令集，`rename()` 原子换文件。
- **崩溃恢复**：二分查找最大的可解析前缀，尾截断可配置（`aof-load-truncated`），
  损坏尾部不影响其余数据加载。
- **RDB**：SAVE/BGSAVE、`save <sec> <changes>` 定时快照、二进制格式（带 CRC64）、
  崩溃恢复时损坏文件拒绝加载。

## 快速开始

```bash
# 启动服务器（默认端口 6379，AOF 开启）
node bin/xredis-server.js --port 6379 --appendonly yes

# 另开一个终端
node bin/xredis-cli.js -p 6379
127.0.0.1:6379> SET greeting "hello"
"OK"
127.0.0.1:6379> GET greeting
"hello"

# 也可以用官方 redis-cli / 任意 Redis 客户端连接
redis-cli -p 6379

# 压测
node bin/xredis-bench.js -p 6379 -n 50000 -c 32 -t set,get -P 8
```

### 主从复制演示

```bash
node bin/xredis-server.js --port 7000            # 主库
node bin/xredis-server.js --port 7001 --replicaof 127.0.0.1 7000   # 副本

redis-cli -p 7001 get somekey   # 副本上读到主库数据
```

## 测试

```bash
npm test        # 依次运行 5 套测试：协议 → 端到端 → AOF 崩溃恢复 → RDB → 主从复制
npm run test:e2e    # 单独运行某一套
```

| 套件 | 覆盖 |
| --- | --- |
| `smoke-protocol.js` | RESP 编解码、分包/粘包、内联命令、bulk 尾部 CRLF 校验、非法输入、二进制安全 |
| `smoke-e2e.js` | 真实 TCP 起服，STRING/LIST/HASH/SET/ZSET/过期（含 NX/XX/GT/LT）/事务/PUBSUB/SCAN/多库/INFO/Lua 脚本/RESP3 客户端/失败路径 |
| `smoke-aof.js` | 写入 → SIGKILL 强杀 → 重启 → 校验全部类型与 TTL 恢复、失败的条件写不落盘 |
| `smoke-rdb.js` | RDB 往返 + CRC 校验、崩溃恢复、损坏文件拒绝 |
| `smoke-repl.js` | 主从全量同步、只读保护、增量传播（含 TTL/条件写/SPOP 确定性）、部分重同步、WAIT |

## 架构一览

```
bin/xredis-server.js   入口（CLI 参数解析、信号处理）
src/main.js            服务器装配
src/server.js          TCP 接入、命令分发、事务、复制、心跳、传播规范化
src/protocol.js        RESP2/RESP3 编解码器
src/client.js          测试/CLI 用的轻量客户端（支持 RESP3）
src/config.js          配置解析（redis.conf 风格 + CLI 参数）
src/store/             数据结构：db / 跳表 / 整数集 / 链表 / 对象编码
src/commands/          命令实现 + 注册表（arity/flags/key 位置元数据）
src/commands/lua.js    EVAL/EVALSHA 脚本引擎（fengari）
src/persistence/       AOF（fsync 策略/重写/崩溃恢复）、RDB、复制 backlog
scripts/               5 套冒烟测试
```

## 已知边界

- RESP3 部分支持：协议层与内置客户端完整支持，`HELLO 3` 可协商，个别
  命令的回复格式可能仍按 RESP2 语义输出。
- 复制为全量同步 + 增量传播 + backlog 部分重同步，未实现磁盘备份（diskless）
  与多级级联复制等高级拓扑。
- 集群（CLUSTER 命令族）不在范围内。

MIT License.