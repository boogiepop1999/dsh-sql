import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../lib/index.js'
import { SETTINGS_DIR_ENV, SETTINGS_FILE_NAME } from '../lib/index.js'

/** 每个测试用独立临时目录，绝不碰真实的 $DSH_HOME/sql。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sql-register-'))
  process.env[SETTINGS_DIR_ENV] = dir
  return {
    dir,
    settingsPath: join(dir, SETTINGS_FILE_NAME),
    cleanup() { delete process.env[SETTINGS_DIR_ENV]; rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) },
  }
}

function makeFakeCtx() {
  const registered = []
  const listeners = {}
  const ctx = {
    tools: {
      register(definition, ...extra) {
        registered.push({ definition, extra })
        return () => {
          const index = registered.findIndex((item) => item.definition === definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener)
      return () => {}
    },
  }
  return { ctx, registered, listeners }
}

test('inject 声明 tools', () => {
  assert.deepEqual(inject, ['tools'])
})

test('apply 注册 9 个工具（官方 register 签名）', () => {
  const box = makeSandbox()
  try {
    const { ctx, registered } = makeFakeCtx()
    apply(ctx)
    assert.equal(registered.length, 9)
    assert.ok(registered.every((item) => item.extra.length === 0))
    assert.ok(registered.every((item) => !Object.hasOwn(item.definition, 'gate')))
  } finally { box.cleanup() }
})

test('apply 首次运行时生成出厂配置文件', () => {
  const box = makeSandbox()
  try {
    const { ctx } = makeFakeCtx()
    apply(ctx)
    const written = JSON.parse(readFileSync(box.settingsPath, 'utf8'))
    assert.deepEqual(written.connections, {}, '出厂不带任何连接')
    assert.equal(written.activeEnv, '')
    assert.deepEqual(written.environments, [])
    assert.equal(written.maxRows, 1000)
    assert.deepEqual(Object.keys(written).sort(), ['activeEnv', 'connections', 'environments', 'maxRows'], '超时是代码常量，不该出现在设置文件里')
  } finally { box.cleanup() }
})

test('apply 不接收配置参数（配置一律来自设置文件）', () => {
  const box = makeSandbox()
  try {
    const { ctx } = makeFakeCtx()
    assert.equal(apply.length, 1, 'apply 只应有 ctx 一个形参')
  } finally { box.cleanup() }
})

test('不再注册 tools/pre-execute 审批钩子（插件不自带写审批）', () => {
  const box = makeSandbox()
  try {
    const { ctx, listeners } = makeFakeCtx()
    apply(ctx)
    assert.equal(listeners['tools/pre-execute'], undefined)
  } finally { box.cleanup() }
})

test('apply 遇到坏设置文件时响亮失败', () => {
  const box = makeSandbox()
  try {
    writeFileSync(box.settingsPath, '{ 这不是 JSON', 'utf8')
    const { ctx, registered, listeners } = makeFakeCtx()
    assert.throws(() => apply(ctx), /不是合法 JSON/)
    assert.equal(registered.length, 0)
    assert.deepEqual(listeners, {})
  } finally { box.cleanup() }
})

test('dispose 卸载全部工具', () => {
  const box = makeSandbox()
  try {
    const { ctx, registered, listeners } = makeFakeCtx()
    apply(ctx)
    assert.equal(registered.length, 9)
    for (const listener of listeners.dispose ?? []) listener()
    assert.equal(registered.length, 0)
  } finally { box.cleanup() }
})
