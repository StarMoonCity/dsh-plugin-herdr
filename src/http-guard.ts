/**
 * CA-007 + DSH-0.1.2-A1-08：HTTP 控制面的双层守卫。
 *
 * 第一层——宿主 Connection 闸门（guardHostGate）：调用
 * `ctx.connection.requestRejection()`，即宿主对 /api 同一套
 * 「Host/Origin 检查 + 浏览器认证（cookie）」。原始 webServer 路由不会自动
 * 继承这层保护，必须显式并入（见 skills/plugin-upgrade 的 A1-08）。
 *
 * 第二层——可信本地上下文守卫（guardLocalRequest + requireMethod）：
 * - 严格方法校验（requireMethod，405 + Allow）；
 * - Host allowlist（仅 localhost/127.0.0.1/::1）——抵御 DNS rebinding（外部域名
 *   解析到 127.0.0.1 时 Host 不是本地名，直接拒绝）；
 * - Origin 同源校验（有 Origin 时必须与 Host 一致）——跨站浏览器请求（CSRF）拒绝；
 * - Sec-Fetch-Site: cross-site 拒绝——现代浏览器兜底（含无 Origin 的 <img> GET）。
 *
 * 两层都放行才进入 handler。宿主闸门缺失时（headless / 极简 profile 未提供
 * connection 服务）退化为仅第二层，路由仍可用——不因缺服务而整体不注册。
 */

/** Node IncomingMessage 的最小子集（webServer handler 入参）。 */
export interface GuardedRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

export interface GuardResult {
  ok: boolean
  /** 拒绝时的 HTTP 状态码（400/403/405）。 */
  status: number
  message: string
}

/**
 * 宿主 Connection 闸门的最小形状——`@deepseek-ai/dsh-client-connection` 的
 * `HostConnectionHandle.requestRejection` 子集（结构化匹配，不引入运行时依赖）。
 */
export interface HostConnectionGate {
  /**
   * 应用 Connection 的 Host/Origin 检查与浏览器认证。
   * @returns 401（未认证）/ 403（不受信来源）表示拒绝；undefined 表示放行。
   */
  requestRejection(request: {
    headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
  }): 401 | 403 | undefined
}

/**
 * 宿主闸门校验。返回拒绝结果；`undefined` 表示放行（含闸门缺失）。
 * @param gate - ctx.connection；缺失时视为无此层。
 * @param req - 待校验请求（只需 headers）。
 */
export function guardHostGate(
  gate: HostConnectionGate | undefined,
  req: GuardedRequest,
): GuardResult | undefined {
  if (!gate) return undefined
  const rejection = gate.requestRejection({ headers: req.headers ?? {} })
  if (rejection === undefined) return undefined
  return {
    ok: false,
    status: rejection,
    message:
      rejection === 401
        ? 'browser authentication required (missing or invalid session cookie)'
        : 'request rejected by the host Connection trust gate (Host/Origin)',
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 从 Host 头解析主机名（剥端口与 IPv6 括号）。 */
export function hostnameOfHost(host: string | undefined): string | undefined {
  if (!host) return undefined
  let h = host.trim()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end >= 0) return h.slice(1, end).toLowerCase()
  }
  const colon = h.indexOf(':')
  if (colon >= 0) {
    // host:port 或裸 IPv6（如 ::1）。端口部分必须全数字才剥离，否则整体视为 IPv6 主机名
    const port = h.slice(colon + 1)
    if (/^\d+$/.test(port)) h = h.slice(0, colon)
  }
  return h.toLowerCase()
}

/** 可信本地上下文校验（方法校验之外的宿主/来源边界）。 */
export function guardLocalRequest(req: GuardedRequest): GuardResult {
  const headers = req.headers ?? {}
  const get = (name: string): string | undefined => {
    const v = headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : v
  }
  const host = hostnameOfHost(get('host'))
  if (!host) return { ok: false, status: 400, message: 'missing Host header' }
  if (!LOCAL_HOSTNAMES.has(host)) {
    return { ok: false, status: 403, message: `untrusted Host: ${host} (control surface is localhost-only)` }
  }
  const origin = get('origin')
  if (origin) {
    // codex review P1：比较完整规范化 authority（scheme + host + 有效端口），
    // 而非仅主机名——本机跨端口 CSRF（localhost:3000 页面 → :3090 控制面）
    // hostname 相同但 origin 不同，必须拒绝。
    // URL.origin 已做默认端口归一（http:80 / https:443 省略）；
    // 请求侧 scheme 固定为 http（DSH web server 为 plain HTTP，见 README）。
    let originAuthority: string
    let requestAuthority: string
    try {
      originAuthority = new URL(origin).origin
      // Host 头原始值（host[:port] 或 [v6]:port）作为请求侧 authority
      requestAuthority = new URL(`http://${get('host')}`).origin
    } catch {
      return { ok: false, status: 400, message: 'malformed Origin header' }
    }
    if (originAuthority !== requestAuthority) {
      return { ok: false, status: 403, message: `cross-origin request rejected (Origin ${originAuthority} != ${requestAuthority})` }
    }
  }
  const secFetchSite = get('sec-fetch-site')
  if (secFetchSite === 'cross-site') {
    return { ok: false, status: 403, message: 'cross-site request rejected (Sec-Fetch-Site)' }
  }
  return { ok: true, status: 200, message: 'ok' }
}

/** 严格方法校验：不匹配返回 405（调用方附 Allow 头）。 */
export function requireMethod(req: GuardedRequest, allowed: string): GuardResult {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === allowed.toUpperCase()) return { ok: true, status: 200, message: 'ok' }
  return { ok: false, status: 405, message: `method ${method} not allowed (use ${allowed.toUpperCase()})` }
}
