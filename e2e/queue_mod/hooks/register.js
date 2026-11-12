// AutoHandoff e2e 的辅助 mod（只给 drive.py 的 queued 场景用，不是产品的一部分）。
// 第一个主回合开始后提交一条 prompt（文字取环境变量 AHQ_TEXT）。插件提交的 prompt 要等会话空闲才跑，所以它一直排到这个回合结束，
// 排在 AutoHandoff 回合结束时才入队的 /clear（或 /compact）前面——和回合中从 Remote Control 发来的消息是同一种排法。
// 驱动脚本没有 Remote Control 客户端，用它代替；AutoHandoff 把别的插件的 prompt 归为用户类来源，走的是同一条分支。
let submitted = false

function note($, text) {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // 写不了日志不影响场景
  }
}

export function register(on) {
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    try {
      const text = await $.env.get('AHQ_TEXT')
      if (!submitted && text && e.agentId === undefined) {
        submitted = true
        // hook 返回之后再提交（hook 里 await 自己发起的 prompt 会被拒）；这时回合已经开始，prompt 只能排队
        $.clock.after(300, () => {
          note($, 'queueing the prompt behind the running turn')
          $.prompt.submit({ text, asUser: true }).then(
            (res) => note($, `the queued prompt entered: ${JSON.stringify(res).slice(0, 160)}`),
            (err) => note($, `the queued prompt was rejected: ${String(err?.message ?? err)}`),
          )
        })
      }
    } catch (err) {
      note($, `internal error: ${String(err?.message ?? err)}`)
    }
    return r
  })
}
