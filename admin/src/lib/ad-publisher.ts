import { Pool } from "@/lib/pool"
import {
  getConnectionToken,
  refreshGoogleAccessToken,
  normalizeGoogleCustomerId,
  normalizeMetaAdAccountId,
  googleAdsCredentials,
} from "@/lib/ad-connections"

type Platform = "google_ads" | "meta_ads" | "instagram_ads"

interface DraftRow {
  id: string
  workspace_id: string | null
  platform: Platform
  status: string
  campaign_name: string
  objective: string
  daily_budget: string | number
  geo_target: { city?: string; state?: string; radiusMiles?: number }
  audience: { description?: string; interests?: string[]; ageRange?: string; exclusions?: string[] }
  keywords: string[]
  negative_keywords: string[]
  ad_groups: Array<{ name: string; keywords: string[]; negativeKeywords?: string[]; creatives: Creative[] }>
  creatives: Creative[]
  landing_page_url: string | null
  approval_notes: string | null
  compliance_warnings: string[] | null
  external_id: string | null
  published_at: string | null
}

interface Creative {
  headlines: string[]
  descriptions: string[]
  primaryText?: string
  callToAction?: string
}

export interface PublishResult {
  ok: boolean
  mode: "dry_run" | "live"
  platform: Platform
  externalId?: string
  blockers?: string[]
  warnings?: string[]
  payload?: Record<string, unknown>
}

export async function publishApprovedAdDraft(pool: Pool, id: string, opts: { dryRun?: boolean } = {}): Promise<PublishResult> {
  const { rows } = await pool.query<DraftRow>(
    `SELECT *
     FROM ad_campaign_drafts
     WHERE id = $1`,
    [id]
  )
  const draft = rows[0]
  if (!draft) {
    return { ok: false, mode: "dry_run", platform: "google_ads", blockers: ["Ad draft not found."] }
  }

  const blockers = validateDraftForPublish(draft)
  if (blockers.length) {
    return { ok: false, mode: "dry_run", platform: draft.platform, blockers }
  }

  const dryRun = opts.dryRun === true || process.env.ADS_PUBLISH_DRY_RUN === "true" || process.env.ADS_PUBLISH_LIVE !== "true"
  const payload = exportPayload(draft)

  if (dryRun) {
    return {
      ok: true,
      mode: "dry_run",
      platform: draft.platform,
      warnings: ["Dry run only. Set ADS_PUBLISH_LIVE=true after platform credentials, spend caps, and conversion tracking are verified."],
      payload,
    }
  }

  const result = draft.platform === "google_ads"
    ? await publishGooglePausedCampaign(pool, draft)
    : await publishMetaPausedCampaign(pool, draft)

  if (!result.ok || !result.externalId) return result

  await pool.query(
    `UPDATE ad_campaign_drafts
     SET status = 'published',
         external_id = $2,
         published_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [draft.id, result.externalId]
  )

  return result
}

function validateDraftForPublish(draft: DraftRow): string[] {
  const blockers: string[] = []
  if (draft.status !== "approved") blockers.push("Draft must be approved before publishing.")
  if (draft.published_at || draft.external_id) blockers.push("Draft is already linked to an external campaign.")
  if (!draft.landing_page_url) blockers.push("Landing page URL is required before publishing ads.")
  if (Number(draft.daily_budget) <= 0) blockers.push("Daily budget must be greater than zero.")
  const compliance = draft.compliance_warnings ?? []
  if (compliance.some((warning) => warning.startsWith("blocker:"))) {
    blockers.push("Compliance blockers must be resolved before publishing.")
  }
  return blockers
}

async function publishGooglePausedCampaign(pool: Pool, draft: DraftRow): Promise<PublishResult> {
  const { developerToken, clientId, clientSecret } = googleAdsCredentials()
  const token = await getConnectionToken(pool, "google_ads", draft.workspace_id)
  const customerId = normalizeGoogleCustomerId(token.customerId || (!draft.workspace_id ? process.env.GOOGLE_ADS_CUSTOMER_ID : undefined))
  const loginCustomerId = normalizeGoogleCustomerId(token.loginCustomerId || (!draft.workspace_id ? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID : undefined))
  const refreshToken = token.refreshToken || (!draft.workspace_id ? process.env.GOOGLE_ADS_REFRESH_TOKEN : undefined)

  const blockers = [
    !developerToken && "GOOGLE_ADS_DEVELOPER_TOKEN or GOOGLE_ADS_DEV_TOKEN is required.",
    !customerId && "GOOGLE_ADS_CUSTOMER_ID is required.",
    !clientId && "Google OAuth client ID is required.",
    !clientSecret && "Google OAuth client secret is required.",
    !refreshToken && "Google Ads refresh token is required. Reconnect Google Ads after adding the secret.",
  ].filter(Boolean) as string[]
  if (blockers.length) return { ok: false, mode: "live", platform: draft.platform, blockers }

  const accessToken = await refreshGoogleAccessToken(clientId!, clientSecret!, refreshToken!)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken!,
    "Content-Type": "application/json",
  }
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId

  const budget = await googleMutate<{ results: Array<{ resourceName: string }> }>(
    customerId!,
    "campaignBudgets",
    headers,
    {
      operations: [{
        create: {
          name: `${draft.campaign_name} Budget ${Date.now()}`,
          amountMicros: Math.round(Number(draft.daily_budget) * 1_000_000),
          deliveryMethod: "STANDARD",
        },
      }],
    }
  )
  const budgetName = budget.results?.[0]?.resourceName
  if (!budgetName) return { ok: false, mode: "live", platform: draft.platform, blockers: ["Google Ads did not return a campaign budget resource."] }

  const campaign = await googleMutate<{ results: Array<{ resourceName: string }> }>(
    customerId!,
    "campaigns",
    headers,
    {
      operations: [{
        create: {
          name: `${draft.campaign_name} ${Date.now()}`,
          advertisingChannelType: "SEARCH",
          status: "PAUSED",
          manualCpc: {},
          campaignBudget: budgetName,
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: true,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
        },
      }],
    }
  )
  const campaignName = campaign.results?.[0]?.resourceName
  if (!campaignName) return { ok: false, mode: "live", platform: draft.platform, blockers: ["Google Ads did not return a campaign resource."] }

  const firstGroup = draft.ad_groups[0]
  if (firstGroup) {
    const adGroup = await googleMutate<{ results: Array<{ resourceName: string }> }>(
      customerId!,
      "adGroups",
      headers,
      {
        operations: [{
          create: {
            name: firstGroup.name,
            campaign: campaignName,
            status: "PAUSED",
            type: "SEARCH_STANDARD",
            cpcBidMicros: 2_000_000,
          },
        }],
      }
    )
    const adGroupName = adGroup.results?.[0]?.resourceName
    if (adGroupName) {
      const keywordOperations = (firstGroup.keywords ?? draft.keywords).slice(0, 20).map((keyword) => ({
        create: {
          adGroup: adGroupName,
          status: "PAUSED",
          keyword: { text: keyword, matchType: "PHRASE" },
        },
      }))
      if (keywordOperations.length) await googleMutate(customerId!, "adGroupCriteria", headers, { operations: keywordOperations })

      const creative = firstGroup.creatives?.[0] ?? draft.creatives[0]
      if (creative) {
        await googleMutate(customerId!, "adGroupAds", headers, {
          operations: [{
            create: {
              adGroup: adGroupName,
              status: "PAUSED",
              ad: {
                finalUrls: [draft.landing_page_url],
                responsiveSearchAd: {
                  headlines: creative.headlines.slice(0, 15).map((text) => ({ text })),
                  descriptions: creative.descriptions.slice(0, 4).map((text) => ({ text })),
                },
              },
            },
          }],
        })
      }
    }
  }

  return { ok: true, mode: "live", platform: draft.platform, externalId: campaignName }
}

async function publishMetaPausedCampaign(pool: Pool, draft: DraftRow): Promise<PublishResult> {
  const provider = draft.platform === "instagram_ads" ? "instagram_ads" : "meta_ads"
  const token = await getConnectionToken(pool, provider, draft.workspace_id)
  const accessToken = token.accessToken || (!draft.workspace_id ? process.env.META_ACCESS_TOKEN : undefined)
  const adAccountId = normalizeMetaAdAccountId(token.adAccountId || (!draft.workspace_id ? process.env.META_AD_ACCOUNT_ID : undefined))
  const blockers = [
    !accessToken && "Meta access token is required. Connect Meta Ads or set META_ACCESS_TOKEN.",
    !adAccountId && "META_AD_ACCOUNT_ID is required.",
  ].filter(Boolean) as string[]
  if (blockers.length) return { ok: false, mode: "live", platform: draft.platform, blockers }

  const body = new URLSearchParams({
    access_token: accessToken!,
    name: `${draft.campaign_name} ${Date.now()}`,
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    special_ad_categories: "[]",
  })
  const res = await fetch(`https://graph.facebook.com/v20.0/${adAccountId}/campaigns`, {
    method: "POST",
    body,
  })
  const data = await res.json() as { id?: string; error?: { message?: string } }
  if (!res.ok || !data.id) {
    return {
      ok: false,
      mode: "live",
      platform: draft.platform,
      blockers: [`Meta campaign creation failed: ${data.error?.message ?? res.statusText}`],
    }
  }

  return {
    ok: true,
    mode: "live",
    platform: draft.platform,
    externalId: data.id,
    warnings: ["Created a paused Meta campaign. Ad set and creative activation still require pixel/page/asset checks."],
  }
}

async function googleMutate<T = Record<string, unknown>>(
  customerId: string,
  resource: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://googleads.googleapis.com/v20/customers/${customerId}/${resource}:mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const data = await res.json() as T & { error?: { message?: string; details?: unknown[] } }
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Google Ads ${resource}:mutate failed`)
  }
  return data
}

function exportPayload(draft: DraftRow): Record<string, unknown> {
  if (draft.platform === "google_ads") {
    return {
      campaign: {
        name: draft.campaign_name,
        advertisingChannelType: "SEARCH",
        status: "PAUSED",
        budget: { amountMicros: Math.round(Number(draft.daily_budget) * 1_000_000) },
        geoTarget: draft.geo_target,
      },
      adGroups: draft.ad_groups.map((group) => ({
        name: group.name,
        keywords: group.keywords,
        ads: group.creatives.map((creative) => ({
          headlines: creative.headlines,
          descriptions: creative.descriptions,
          finalUrl: draft.landing_page_url,
        })),
      })),
    }
  }

  return {
    campaign: {
      name: draft.campaign_name,
      objective: draft.objective,
      status: "PAUSED",
      dailyBudget: Number(draft.daily_budget),
      geoTarget: draft.geo_target,
      audience: draft.audience,
    },
    creatives: draft.creatives.map((creative) => ({
      primaryText: creative.primaryText,
      headlines: creative.headlines,
      descriptions: creative.descriptions,
      callToAction: creative.callToAction,
      destinationUrl: draft.landing_page_url,
    })),
  }
}
