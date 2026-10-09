import type { Context } from '@deepseek-ai/cordis'
import type { JobKindMap, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'

// 声明我们的 producer kind（id 前缀 herdr-1, herdr-2 ...）
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    herdr: 'herdr'
  }
}
export type HerdrJobKind = JobKindMap['herdr']

/**
 * 等待类工具的后台 producer（DESIGN.md §9）。
 *
 * 前台与后台共用同一个等待实现：前台传 exec.signal，后台传 task-owned
 * AbortSignal；cancel 链路：job_kill → producer.cancel → abort → 等待实现。
 *
 * CA-015 取消语义：
 * - cancel 同步、幂等（AbortController.abort 二次调用为 no-op），reason 透传；
 * - 取消导致的中止 → outcome `killed`（框架认可的取消状态），区别于真实失败 `failed`；
 * - done 必 settle 且不 reject（catch 全覆盖；等待实现须观察 signal，cancel 后即 settle）。
 *
 * DSH 0.2 契约：`JobOutcome.output` 改名为 `result`，`JobHooks.readOutput` 被移除。
 * `result` 正是"final-output job"的载体——读面 `job_output` 在 settle 后首次读取时
 * 一次性交出该值（见 @deepseek-ai/dsh-tool-jobs README「final-output jobs return
 * their result after settlement」），与旧的 readOutput 语义等价。
 */
export interface WaitJobSpec<T> {
  /** 拥有该任务的 agent（会话围栏 + 所有者清理）。 */
  owner?: JobSpec['owner']
  /** 一行模型可见标签。 */
  label: string
  /** 真实等待逻辑（观察/转发 signal）。 */
  wait: (signal: AbortSignal) => Promise<T>
  /** 结果 → 模型可读最终文本（JobOutcome.result）。 */
  render: (result: T) => string
}

/** 启动后台任务，返回 registry 签发的 jobId（如 herdr-1）。 */
export function startWaitJob<T>(ctx: Context, spec: WaitJobSpec<T>): string {
  return ctx.jobs.start({
    kind: 'herdr',
    label: spec.label,
    owner: spec.owner,
    run: () => {
      const controller = new AbortController()
      let cancelReason: string | undefined
      const done = spec
        .wait(controller.signal)
        .then<JobOutcome>(result => ({ status: 'completed', result: spec.render(result) }))
        .catch((err: unknown): JobOutcome => {
          const detail = err instanceof Error ? err.message : String(err)
          // CA-015：取消（cancel → abort）是 killed 语义；真实失败才是 failed
          if (controller.signal.aborted) {
            return { status: 'killed', detail: cancelReason ?? 'cancelled', result: detail }
          }
          return { status: 'failed', detail, result: detail }
        })
      return {
        // CA-015：同步、幂等（AbortController.abort 二次调用为 no-op）、reason 首报即锁定
        cancel: reason => {
          if (!controller.signal.aborted) cancelReason = reason
          controller.abort(reason)
        },
        done,
      }
    },
  })
}
