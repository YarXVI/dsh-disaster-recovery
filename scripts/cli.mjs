/**
 * 不依赖 DSH 的入口：DSH 起不来时用它。
 *
 *   node scripts/cli.mjs list
 *   node scripts/cli.mjs backup
 *   node scripts/cli.mjs restore latest
 *   node scripts/cli.mjs restore 20261026-124500-change
 *   node scripts/cli.mjs verify latest
 *
 * 参数：
 *   --home <dir>    默认 $DSH_HOME 或 ~/.dsh
 *   --root <dir>    默认取配置（D:\dsh-backup）
 *   --yes           跳过确认（restore）
 */
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { BackupEngine, CONFIG_DEFAULTS } from '../src/engine.js'
import { formatBytes } from '../src/util.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) out[key] = true
      else { out[key] = next; i += 1 }
    } else {
      out._.push(arg)
    }
  }
  return out
}

function resolveHome(args) {
  if (typeof args.home === 'string') return path.resolve(args.home)
  const env = process.env.DSH_HOME
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'list'
  const home = resolveHome(args)
  const config = { ...CONFIG_DEFAULTS }
  if (typeof args.root === 'string') config.root = args.root

  const engine = new BackupEngine({
    home,
    config,
    log: (m) => console.error(`[backup] ${m}`),
    // 只有 backup 才在启动时补一次快照；list/verify/restore 绝不能拍，
    // 否则“事故后的坏状态”会变成 latest，恢复就变成空操作。
    snapshotOnStart: command === 'backup',
  })
  await engine.start()

  const printState = (state) => {
    console.log(`home      : ${state.home}`)
    console.log(`store     : ${state.storeDir}`)
    console.log(`snapshots : ${state.snapshotCount}`)
    if (state.lastSnapshot) {
      console.log(`latest    : ${state.lastSnapshot.id}  (${new Date(state.lastSnapshot.at).toLocaleString()}, ` +
        `${state.lastSnapshot.files} files)`)
    }
    if (state.blob) console.log(`blobs     : ${state.blob.count} 个 / ${formatBytes(state.blob.bytes)}`)
  }

  try {
    if (command === 'list') {
      await engine.refreshBlobStats()
      const state = engine.state()
      if (args.json) {
        console.log(JSON.stringify({
          home: state.home,
          store: state.storeDir,
          snapshots: state.snapshots,
          blob: state.blob,
          paused: state.paused,
        }, null, 2))
        return 0
      }
      printState(state)
      console.log('')
      if (!state.snapshots.length) console.log('（还没有快照）')
      for (const snap of state.snapshots.slice(0, 40)) {
        console.log(`${snap.id.padEnd(34)} ${new Date(snap.at).toLocaleString().padEnd(22)} ` +
          `${String(snap.files).padStart(5)} files  ${String(snap.reason).padEnd(12)}`)
      }
      return 0
    }

    if (command === 'backup') {
      const result = await engine.snapshot('cli')
      await engine.refreshBlobStats()
      if (result.skipped) console.log(`未变化，跳过（${result.reason}）`)
      else console.log(`已备份 ${result.id}: ${result.files} files, 新增内容 ${formatBytes(result.bytes)}`)
      printState(engine.state())
      return 0
    }

    if (command === 'verify') {
      const target = args._[1] || 'latest'
      const id = target === 'latest' ? engine.latestSnapshotId() : target
      if (!id) { console.error('没有可用快照'); return 1 }
      const manifest = await engine.store.readManifest(id)
      const verify = await engine.store.verify(manifest)
      console.log(`snapshot ${id}: ${verify.files} files, missing blobs ${verify.missing.length}`)
      if (verify.missing.length) { console.log(verify.missing.slice(0, 20).join('\n')); return 2 }
      return 0
    }

    if (command === 'restore') {
      const target = args._[1] || 'latest'
      const id = target === 'latest' ? engine.latestSnapshotId() : target
      if (!id) { console.error('没有可用快照'); return 1 }
      console.log(`即将把 ${id} 恢复到 ${home}`)
      console.log('当前状态会先自动做一次 pre-restore 快照；被覆盖的文件另存到 restore-quarantine。')
      if (!args.yes && !(await confirm('确认恢复？'))) { console.log('已取消'); return 1 }
      const result = await engine.restore(id)
      console.log(`恢复完成：覆盖 ${result.restored}，未变 ${result.unchanged}，隔离 ${result.quarantined}`)
      if (result.extraLeft) console.log(`快照里没有、当前保留未动的文件：${result.extraLeft}`)
      if (result.failed.length) {
        console.log(`失败 ${result.failed.length} 项：`)
        for (const item of result.failed.slice(0, 20)) console.log(`  ${item.rel}: ${item.reason}`)
      }
      console.log('请完全退出并重新启动 DeepSeek Harness。')
      return result.failed.length ? 3 : 0
    }

    console.error(`未知命令：${command}（可用 list / backup / restore / verify）`)
    return 1
  } finally {
    await engine.stop()
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(String((error && error.stack) || error))
  process.exit(1)
})
