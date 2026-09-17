# deploy/

Unit files for the host. Everything else about deployment is in
`docs/17_OPERATOR_ACCESS.md` §2.

- `bananasaurs.service` — the daemon. **Runs the checkout's `dist/`**, so a
  build on this box is a deployment; migrate (stop → migrate → start) before
  restarting after a merge that adds a migration. `docs/STATE.md`,
  2026-09-17, records what happens otherwise.
- `bananasaurs-test.service` — the test variant.

**There is no `cloudflared` unit or config here on purpose.** The tunnel is
remotely managed: `cloudflared service install <token>` wrote its own unit,
and the ingress lives in the Cloudflare dashboard, not on disk. What the
tunnel and Access must look like — and the `doctor` probe that verifies
them from outside — is `docs/17` §2.4. The one on-box change worth making is
moving the tunnel token out of the unit's `ExecStart` into a `0600`
`EnvironmentFile`; §2.4 has the commands.
