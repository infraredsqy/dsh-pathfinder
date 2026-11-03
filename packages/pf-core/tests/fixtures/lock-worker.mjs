// 锁的跨进程用例工作进程（普通 JS，node 直接跑；src 是纯类型标注的 TS：Node 22.6–23.x
// 靠测试传入的 --experimental-strip-types 加载，24+ 原生加载，22.0–22.5 无旗标不跑）。
//
//   node lock-worker.mjs hold    <projectRoot> <recordAbsPath> <holdMs>
//     拿锁 → 写一条记录（payload=holder）→ 按给定时长握着 → 放锁 → exit 0。
//
//   node lock-worker.mjs contend <projectRoot> <recordAbsPath> <payload> <timeoutMs>
//     带超时拿锁，拿到后写同一条记录（payload=第二个参数）：
//     成功打印 ACQUIRED、exit 0；超时打印 TIMEOUT:lock_timeout、exit 3。
//
// 全部落点由 pfPaths 决定；引擎操作只碰调用方给的那棵临时记录树。

import { setTimeout as sleepMs } from 'node:timers/promises';
import { atomicWriteJson } from '../../src/jsonio.ts';
import { withLedgerLock } from '../../src/ledgerlock.ts';
import { pfPaths } from '../../src/paths.ts';

const [, , mode, projectRoot, recordPath, value, timeoutMs] = process.argv;
const paths = pfPaths(projectRoot);

if (mode === 'hold') {
  await withLedgerLock(paths, async () => {
    await atomicWriteJson(recordPath, { payload: 'holder' });
    await sleepMs(Number(value));
  });
  process.exit(0);
}

if (mode === 'contend') {
  try {
    await withLedgerLock(
      paths,
      async () => {
        await atomicWriteJson(recordPath, { payload: value });
      },
      { timeoutMs: Number(timeoutMs) },
    );
    console.log('ACQUIRED');
    process.exit(0);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'lock_timeout') {
      console.log('TIMEOUT:lock_timeout');
      process.exit(3);
    }
    console.log(`UNEXPECTED:${error && error.message}`);
    process.exit(2);
  }
}

console.log(`UNKNOWN-MODE:${mode}`);
process.exit(64);
