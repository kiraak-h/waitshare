export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.headers as Record<string, string>),
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`/api/v1${path}`, { ...options, headers })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      const body = await res.json()
      if (body.error) detail = body.error
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}
