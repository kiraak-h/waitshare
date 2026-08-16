export function millsToDollars(mills: number): string {
  return (mills / 100000).toFixed(4)
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n))
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 0) return "now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export interface SplitDto {
  devShare: number
  platformShare: number
  version: number
  lockedAt: number
}

export interface CampaignDto {
  id: string
  advertiserId: string
  adLine: string
  url: string
  brandIcon: string | null
  surface: string
  cpmCents: number
  blocks: number
  impressionsBought: number
  impressionsServed: number
  countryFilter: string[] | null
  deliverySpeed: string
  status: string
  createdAt: number
}

export interface AuctionStateDto {
  generatedAt: number
  market: {
    cpmCents: number
    impressionsPerHour: number
    adSecondsPerHour: number
    devEarnedPerHourCents: number
  }
  surfaceCpm: Record<string, number>
  campaigns: CampaignDto[]
}

export interface LedgerDto {
  entries: {
    campaignId: string
    brand: string
    adLine: string
    surface: string
    cpmCents: number
    served: number
    bought: number
    grossMills: number
    devShareMills: number
  }[]
  total: { grossMills: number; devShareMills: number; served: number }
}
