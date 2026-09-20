import { Agent, setGlobalDispatcher } from 'undici';

// Node ≥ 24 的内置 fetch 默认启用 HTTP/2：对 googleapis 的并发长请求会复用同一条连接并被逐个处理
// （实测 4 屏并行退化为 17/36/51/68 s；关掉后 19/17/22/26 s）。LLM SDK 都走全局 fetch，这里统一改回 HTTP/1.1。
setGlobalDispatcher(new Agent({ allowH2: false }));
