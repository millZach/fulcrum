import { ProviderUsageError } from "@fulcrum/domain";

const quotaLanguage =
  /(?:\b429\b|quota[-_ ]?(?:exceeded|exhausted)|rate[-_ ]?limit|too many requests|usage limit)/i;

const recordSignalsQuota = (value: unknown, seen: Set<object>): boolean => {
  if (typeof value === "string") return quotaLanguage.test(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (Number(record.status ?? record.statusCode) === 429) return true;
  if (
    [record.code, record.type].some(
      (entry) => typeof entry === "string" && quotaLanguage.test(entry),
    )
  )
    return true;
  if (value instanceof Error && quotaLanguage.test(value.message)) return true;

  return [
    record.message,
    record.detail,
    record.stderr,
    record.body,
    record.error,
    record.cause,
    record.response,
  ].some((entry) => recordSignalsQuota(entry, seen));
};

export const isSubscriptionQuotaPressure = (error: unknown): boolean =>
  recordSignalsQuota(error, new Set<object>());

export const subscriptionQuotaError = (
  error: unknown,
  providerName: string,
): ProviderUsageError | undefined =>
  isSubscriptionQuotaPressure(error)
    ? new ProviderUsageError(
        "subscription-quota",
        `${providerName} subscription usage is temporarily limited.`,
      )
    : undefined;
