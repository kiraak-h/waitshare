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

export interface DevDto {
  id: string
  email: string
  country: string | null
  status: string
  balanceCents: number
  reserveCents: number
  totalEarnedCents: number
  paidCents: number
  stripeOnboarded: boolean
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

export interface LedgerEntryDto {
  campaignId: string
  brand: string
  adLine: string
  surface: string
  cpmCents: number
  served: number
  bought: number
  grossMills: number
  devShareMills: number
}

export function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2)
}
