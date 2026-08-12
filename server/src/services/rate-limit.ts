import type { RequestHandler } from "express"

export interface RateLimitOpts {
  windowMs: number
  max: number
}

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

export function rateLimit(opts: RateLimitOpts): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip ?? "unknown"
    const now = Date.now()
    let w = windows.get(ip)
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs }
      windows.set(ip, w)
    }
    w.count += 1
    if (w.count > opts.max) {
      res.status(429).json({ error: "rate limit exceeded", retryAfterMs: Math.max(0, w.resetAt - now) })
      return
    }
    next()
  }
}

export function resetRateLimits(): void {
  windows.clear()
}
