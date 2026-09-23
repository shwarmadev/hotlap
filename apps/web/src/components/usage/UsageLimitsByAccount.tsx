import {
  collectLimitGroups,
  collectLimitNotices,
  type LimitGroup,
  type LimitPresentations,
  type LimitRow,
} from "@t3tools/shared/usageLimits";
import { AlertTriangleIcon } from "lucide-react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Alert, AlertTitle } from "../ui/alert";
import { LimitWindows, ResetCredits } from "./UsageLimits";

/** `someone@example.com` → `SE`: enough to tell accounts apart, too little to identify one. */
function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

/** A stable hue per email, so the same account gets the same chip on every visit. */
function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The two-letter chip for a hub account, which has no instance icon of its own. */
function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function driverLabel(driver: LimitGroup["driver"]): string {
  return getDriverOption(driver)?.label ?? String(driver);
}

/**
 * Who the row is: the instance name in full (wrapping, never truncated), or
 * the hub's account id; the email stays redacted until clicked.
 */
function RowHeader({ row }: { readonly row: LimitRow }) {
  const account = row.kind === "account" ? row.account : null;
  const driver = row.kind === "account" ? row.account.driver : row.driver;
  const environments = row.kind === "account" ? row.account.environments : row.environments;
  const where =
    environments.length > 0
      ? `Signed in ${environments.map((environment) => environment.label).join(", ")}`
      : account?.sourceLabel
        ? `Via ${account.sourceLabel}`
        : null;
  const name = row.displayName ?? (account?.email ? null : driverLabel(driver));
  // Hub-only accounts have no instance to draw, so they get the email chip.
  const hubOnly = account !== null && account.environments.length === 0 && !row.displayName;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {!hubOnly || !account?.email ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={row.displayName ?? driverLabel(driver)}
          accentColor={row.kind === "account" ? row.account.accentColor : row.accentColor}
          showBadge={Boolean(row.displayName)}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
      ) : (
        <AccountChip email={account.email} />
      )}
      {name ? (
        <span className="min-w-0 text-sm font-medium break-words text-foreground">{name}</span>
      ) : null}
      {account?.plan ? <span className="text-xs text-muted-foreground">{account.plan}</span> : null}
      {where ? <span className="text-xs text-muted-foreground">{where}</span> : null}
      {account?.email ? (
        <RedactedSensitiveText
          value={account.email}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
          className="w-fit text-xs"
        />
      ) : null}
    </div>
  );
}

/** One account: its own windows, reset times and reset credits, or why there are none. */
function AccountRow({ row, now }: { readonly row: LimitRow; readonly now: number }) {
  const account = row.kind === "account" ? row.account : null;
  const credits = account?.limits.resetCredits;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-4">
      <RowHeader row={row} />
      {row.kind === "account" ? (
        <LimitWindows driver={row.account.driver} windows={row.windows} now={now} />
      ) : (
        <p className="text-xs text-muted-foreground">{row.message}</p>
      )}
      {account?.redeem && credits ? (
        <ResetCredits
          environmentId={account.redeem.environmentId}
          input={account.redeem.input}
          credits={credits}
          now={now}
        />
      ) : null}
    </div>
  );
}

function ProviderGroup({ group, now }: { readonly group: LimitGroup; readonly now: number }) {
  const label = driverLabel(group.driver);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={group.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        {label}
        {group.rows.length > 1 ? (
          <span className="font-normal text-muted-foreground">{group.rows.length} accounts</span>
        ) : null}
      </h2>
      {group.rows.map((row) => (
        <AccountRow key={row.key} row={row} now={now} />
      ))}
    </section>
  );
}

/**
 * Subscription limits as one row per account, grouped by provider. Accounts
 * are separate quotas, so nothing is averaged across them; a configured lane
 * with nothing reported yet still gets its row.
 */
export function UsageLimitsByAccount({
  presentations,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
}) {
  const groups = collectLimitGroups(presentations);
  // Provider failures already show on their own rows; only hub failures need the banner.
  const notices = collectLimitNotices(presentations, { providers: false });
  return (
    <div className="flex flex-col gap-8">
      {groups.length === 0 && notices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {groups.map((group) => (
        <ProviderGroup key={group.driver} group={group} now={now} />
      ))}
      {notices.length > 0 ? (
        <Alert variant="warning" controlAlignment="first-line">
          <AlertTriangleIcon />
          {notices.map((notice) => (
            <AlertTitle key={notice} className="break-words">
              {notice}
            </AlertTitle>
          ))}
        </Alert>
      ) : null}
    </div>
  );
}
