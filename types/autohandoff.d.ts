// AutoHandoff 的类型契约（plugin.json 的 "types"）：只声明本插件放在 `$.state` 里的值。
// `$.state` 由宿主按会话保存，热重载后还在、进程重启后是空的；register.ts 用它区分这两种情况。
/** 本进程发出过的、交接 job 的重置命令（core.jobKey），最近的 20 个 */
export type AutohandoffQueued = string[]

declare module 'claude-code' {
  interface PluginState {
    autohandoff: {
      queued: AutohandoffQueued
    }
  }
}
