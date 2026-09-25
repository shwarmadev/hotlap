# Hotlap release checklist

> For maintainers. Installing Hotlap? See [Install](../user/install.md).

## Release channels and source commit

The [Release workflow](../../.github/workflows/release.yml) builds npm, desktop,
bundled web, and standalone CLI archives from one resolved commit.

- Manual `channel=stable` promotes the latest published nightly's commit, not
  the current `main`, using the stable version that nightly previewed.
- Pushing an exact `vX.Y.Z` tag releases that commit. Suffixed tags are rejected
  from the stable channel.
- Nightly checks run daily at 15:08 UTC. Automatic nightlies require new commits
  and a six-hour publication gap; manual `channel=nightly` bypasses those checks.
  New nightlies preview the patch after the highest published stable version,
  so they are newer than the stable channel they follow.
- Manual `channel=preview` exercises the release pipeline for a maintainer test
  build. It publishes a real prerelease and npm `preview` dist-tag, but no desktop
  updater metadata. Stable and nightly users are never offered preview updates.
- The dispatch channel defaults to `preview`, so an omitted selection cannot
  publish a stable release. Stable and nightly dispatches must select `main`, and
  their commit must be contained in it; preview builds any branch.
- Publishers are serialized and are not cancelled by newer releases.
- Stable and nightly versions are checked against both GitHub releases and npm
  `latest` before work starts and again immediately before npm publication. A
  stale version stops instead of moving either update channel backwards.

Hotlap has no hosted web, relay, or marketing deployment. Its web app ships inside
npm, desktop, and CLI archives. Relay/Clerk configuration is empty. Upstream-only
hosted deployment, AUR, announcement, and version-finalization jobs are guarded
to run only in `pingdotgg/t3code`; they must remain disabled for Hotlap.

## Pull request macOS previews

Upstream's `preview:mac` label workflows
(`.github/workflows/desktop-macos-preview.yml` and
`.github/workflows/desktop-macos-preview-publish.yml`) build a PR's JS bundle
without secrets, then package, sign, and notarize it from `main` and upload it to
a rolling `desktop-preview` prerelease. They are not part of Hotlap's release
process: they read public T3 Connect identifiers from `.env.example` and target
upstream Blacksmith runners. Do not apply `preview:mac` in Hotlap unless those
workflows are adapted to Hotlap's signing and empty Relay/Clerk policy; use the
`channel=preview` release train for maintainer test builds.

## Artifacts and runtime compatibility

The workflow builds the shared JavaScript bundle once, then uses
[release-desktop.yml](../../.github/workflows/release-desktop.yml) for six targets:

- macOS arm64 and x64: DMG and updater ZIP.
- Linux arm64 and x64: AppImage.
- Windows arm64 and x64: NSIS installer, including a matching Linux WSL runtime.

Five targets also produce standalone CLI archives:
`hotlap-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows), plus
`SHA256SUMS`. There is no darwin-x64 SEA archive; Intel Macs retain desktop and
Node/npm support. Archives are smoke-tested on matching hardware before upload.
The executable inside remains named `t3`/`t3.exe` for the internal runtime
layout; standalone installers expose the public command `hotlap`.

Hotlap publishes **one npm package**, `hotlap`, containing the Node server,
bundled web client, native dependencies, and resource monitors. It does not use
upstream's `@t3code/*` packages. The Node distribution retains
`dist/service-launcher.mjs` and its pinned
`node_modules/hotlap/dist/bin.mjs` layout so installed Node service launchers can
continue updating. Standalone services use the archive layout instead. Do not
replace one layout with the other during an ordinary server update.

The standalone installers live in `scripts/install.sh` and
`scripts/install.ps1`; their `HOTLAP_*` settings and `~/.hotlap` default are
documented in [Background service](../user/background-service.md). Download
origins must remain `shwarmadev/hotlap`, never upstream T3 releases.

Mobile uses separate EAS workflows. When `EXPO_TOKEN` is available, the release
workflow attaches the newest finished Android production APK; this does not
build or validate a new mobile version for that source commit.

## Publication order and smoke checks

1. Quality checks, the shared bundle, and all six platform builds must pass.
2. `publish_cli` checks the package with a dry run and publishes
   `hotlap@<version>` under `latest`, `nightly`, or `preview`.
3. `release` exposes desktop artifacts, CLI archives, and checksums only after
   npm publication succeeds.

Preserve this order: older Node-managed servers need the exact npm version when
a new client requests an update. Archive-managed servers need the matching
release archive. Neither should resolve a different channel or product.

Before promoting a nightly:

- Confirm `npm view hotlap@<version> version`, then smoke-test
  `npx hotlap@<version>` with isolated state.
- Install the desktop artifact, check its bundled web client, and verify the
  updater points to Hotlap.
- Exercise previous-version Node and standalone services updating to the new
  exact version. Include an Intel Mac npm path.
- Verify a failed trial restores its database snapshot and previous server.
  If the launcher protocol is unsupported, update must stop before restarting;
  run `npx hotlap@<version> service update` on the host to repair it.
- Verify archive checksums and execution, plus Windows WSL startup.
- Check mobile compatibility separately before distributing its build/update.

Dispatch stable only after verifying the nightly. Check the workflow's resolved
SHA: a newer nightly may have appeared since testing. Use an explicit stable tag
when a particular tested commit must ship.

There is no non-publishing release mode. A test tag matching the stable trigger
still publishes to npm `latest`. Use local checks or CI for dry validation;
preview and nightly dispatches also create real published artifacts.

## npm trusted publishing

Keep the existing trusted publisher on the `hotlap` npm package:

<<<<<<< HEAD
- Provider: GitHub Actions.
- Repository: `shwarmadev/hotlap`.
- Workflow: `.github/workflows/release.yml`.
- Environment: match the package's configured trusted publisher, if one is used.
=======
- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.
>>>>>>> fd465100581055383126aab922a8da2c5d7952fd

`publish_cli` has `id-token: write` and invokes
`node apps/server/scripts/cli.ts publish --app-version <version> --tag <tag>`.
No new npm namespace or platform-package credentials are required. The workspace
package is still internally named `t3`; publishing temporarily applies Hotlap
metadata and restores the original files afterward.

## Signing

Signing is detected from configured credentials. Missing credentials can produce
unsigned artifacts; a successful workflow alone does not prove signing.

### macOS

Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `MACOS_PROVISIONING_PROFILE`.
Repository variable: `APPLE_TEAM_ID`.

<<<<<<< HEAD
Use a Developer ID Application certificate for the Hotlap team and a compatible
profile for `ai.usefastlane.code`. Store the certificate/private-key P12 and
provisioning profile base64-encoded; store `APPLE_API_KEY` as raw P8 text.
The workflow materializes and validates them in temporary runner files.
Check signatures and notarization on both desktop and standalone artifacts,
including native addons inside archives. Do not substitute upstream's app ID
or enable hosted Clerk configuration to make signing pass.
=======
### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are never candidates.
3. Set `dry-run`, deploy, and read the sweep counters (`scanned`, `wouldDelete`, `skippedLegacy`,
   `skippedOrphan`, `failed`, `truncated`) across several sweeps.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
`RELAY_TUNNEL_CLEANUP_MODE` is read at deploy time. Changing it, including turning cleanup off during
an incident, needs a relay deploy.

To roll back, set cleanup to `off` and deploy the relay before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable T3 home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use T3 server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same T3 home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

## Marketing site deployment
>>>>>>> fd465100581055383126aab922a8da2c5d7952fd

### Windows

Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

The Entra service principal needs signing access to the configured Azure Trusted
Signing account/profile. Verify signatures on installers and CLI executables.

## Desktop updater invariants

The GitHub updater must use `shwarmadev/hotlap`. Check
`T3CODE_DESKTOP_UPDATE_REPOSITORY` if overriding the build's repository.
Stable publishes `latest*.yml`, nightly publishes `nightly*.yml`, and both
include blockmaps. Preview publishes neither manifests nor blockmaps.

macOS uses one combined per-channel manifest for Intel and Apple Silicon.
Preserve the manifest merge step and macOS ZIP assets alongside the DMGs.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`hotlap-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
by the Linux desktop job and handed to the Windows desktop build as
`--wsl-runtime`, copied in verbatim so WSL runs the exact bytes a Linux user
downloads. WSL verifies and extracts that archive
into `~/.hotlap/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `hotlap-<version>-linux-<arch>` directory holding `t3`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.
