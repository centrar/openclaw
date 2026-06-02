---
summary: "Run the local-first Agent OS alpha and collect proof that agents, sidecars, memory, and packages work together"
read_when:
  - You want to boot the Agent OS alpha substrate
  - You need release-candidate proof for full-local, package, and golden E2E behavior
  - You are deciding where native agents end and external framework adapters begin
title: "Agent OS alpha"
---

Agent OS alpha is the local-first, proof-native runtime profile for OpenClaw. It boots the Gateway, Sentinel, signal-hub, Blackboard, memory/wiki sync, capability agent profiles, and proof-event contracts as one local substrate.

Use this page when you want to prove real work locally: submit a ticket, route it to a capability agent, record proof, survive restart, and package the same files that made the proof pass.

## Scope

Agent OS alpha is a product branch and release-candidate lane. It is not an upstream OpenClaw landing PR and it should not be submitted upstream as one large substrate. Keep upstream contributions narrow and owner-reviewed.

The alpha claim is intentionally bounded:

- local-first Agent OS runtime for one machine or server
- native OpenClaw capability agents as the first-class worker model
- durable tickets through Blackboard
- proof events and artifact contracts for every delivered task
- Sentinel-protected model access for full-local proof
- package proof from a tarball, not only from a source checkout

Do not claim hostile multi-tenant isolation, a distributed global scheduler, or "billions of agents" until those surfaces have separate proofs.

## Before you begin

You need:

- Node 24 recommended, or Node 22.19+
- pnpm from the repo package manager
- Docker with Compose support for full-local proof
- an NVIDIA API key for Sentinel-backed model and embedding proof
- a private operator shell where secrets will not be printed

Set credentials as environment variables or through your normal OpenClaw config. Do not commit keys or copy them into docs, tickets, proof bundles, or workflow logs.

## Boot the alpha

Clone the product branch and install dependencies:

```bash
git clone https://github.com/centrar/openclaw.git
cd openclaw
git checkout codex/agent-os-alpha
pnpm install --frozen-lockfile
```

Set runtime secrets in your shell:

```bash
export NVIDIA_API_KEY="<NVIDIA_API_KEY>"
export OPENCLAW_GATEWAY_TOKEN="<LOCAL_GATEWAY_TOKEN>"
export OPENCLAW_SENTINEL_TOKEN="<LOCAL_SENTINEL_TOKEN>"
```

Windows PowerShell uses `$env:NVIDIA_API_KEY = "<NVIDIA_API_KEY>"`.

Start the full-local stack:

```bash
pnpm local:full
```

Expected result:

```text
Full local proof: ready
OK service:openclaw-gateway
OK service:openclaw-sentinel
OK service:openclaw-signal-hub
OK service:openclaw-obsidian-syncer
OK gateway:readyz
OK sentinel:readyz
OK memory-wiki:status
```

Stop the stack when you are done:

```bash
pnpm local:full:down
```

## Collect release-candidate proof

Run the benchmark gauntlet:

```bash
pnpm local:full:bench
```

Expected result:

```text
Benchmark gauntlet: passed
Tasks: 5/5 ok
toolErrors=0
```

Run the golden Agent OS E2E:

```bash
pnpm local:full:golden
```

Expected result:

```text
Agent OS golden E2E: passed
OK ticket accepted
OK ticket routed
OK ticket completed
OK proof event contract
OK ticket contract in proof
OK artifact contract
OK proof survived restart
```

The important proof artifacts are:

| Artifact                                         | Purpose                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| `.artifacts/full-local-proof.json`               | Readiness proof for services, Gateway, Sentinel, and wiki |
| `.artifacts/full-local-benchmark.json`           | Benchmark gauntlet results and task outcomes              |
| `.artifacts/full-local-agent-os-golden-e2e.json` | Ticket, proof, artifact, and restart-survival evidence    |

## Prove the package

Package proof must start from the same commit you plan to tag or ship:

```bash
node scripts/package-openclaw-for-docker.mjs --output-dir .artifacts/agent-os-rc-package
```

The package script builds release artifacts, writes the package inventory, packs the npm tarball, extracts it, and checks the dist import graph.

After packing, inspect the Agent OS files in the tarball:

```bash
tar -tf .artifacts/agent-os-rc-package/openclaw-*.tgz | grep -E 'agent-os-agent-delivery-proof|agent-os-agent-inventory|agent-os-agent-manager|agent-os-agent-purpose-catalog|agent-os-native-exec-proof|agent-os-contracts|proof-events|full-local|capability-agent-profile|capability-proof-kit|capability-agents|agent-os-contract'
```

At minimum the tarball must contain:

- `scripts/docker/full-local.mjs`
- `scripts/docker/sidecars/`
- `scripts/lib/agent-os-contracts.cjs`
- `scripts/lib/proof-events.cjs`
- `scripts/agents/agent-os-agent-delivery-proof.mjs`
- `scripts/agents/agent-os-agent-inventory.mjs`
- `scripts/agents/agent-os-agent-manager.mjs`
- `scripts/agents/agent-os-agent-purpose-catalog.mjs`
- `scripts/agents/agent-os-native-exec-proof.mjs`
- `scripts/agents/capability-agent-profile.mjs`
- `scripts/agents/capability-proof-kit.mjs`
- `docs/start/agent-os-alpha.md`
- `docs/reference/agent-os-contract.md`
- `docs/tools/capability-agents.md`

## CI release-candidate gate

The `Agent OS RC` workflow is the repeatable branch gate. It runs:

- docs index check
- syntax checks for full-local and package scripts
- contract, proof, capability-agent, full-local, package, and Sentinel security tests
- package build, tarball integrity check, tarball inventory check, and install-from-tarball smoke
- Docker full-local boot, benchmark, golden E2E, and cleanup

The Docker proof job requires the repository secret `NVIDIA_API_KEY`. On normal branch pushes, the job records a notice and skips Docker proof when the secret is not configured. On a manual RC run with `run_docker=true`, it fails closed if the secret is missing. The workflow sets local-only Gateway and Sentinel tokens for CI.

Run it manually when preparing an RC:

```bash
gh workflow run agent-os-rc.yml --ref codex/agent-os-alpha
```

## Security baseline

Full-local is powerful. Treat it as an operator-owned local runtime.

- Gateway, Sentinel, bridge, and Teams host ports publish to loopback by default.
- LAN publish bindings require `OPENCLAW_FULL_LOCAL_ALLOW_LAN_PUBLISH=1`.
- Sentinel requires a token for model proxy requests.
- Direct Sentinel runs refuse unauthenticated non-loopback binds unless explicitly allowed.
- Host mounts are constrained to the config, state, workspace, sidecar, and proof surfaces needed for the substrate.
- Custom Sentinel vault paths must stay inside mounted container roots and must not point at read-only config mounts.
- Windows native bridge dispatch only runs explicitly configured native agents and records dispatch attempts to `proof_events`.
- Sidecars should not receive channel credentials or auth-profile secrets unless they need named references.

For the field-level security contract, use [Agent OS contract](/reference/agent-os-contract). For the native agent workflow, use [Capability agents](/tools/capability-agents).

## Adapter strategy

Make native OpenClaw capability agents stable first. They are the Win32-style contract for this system: documented, boring, powerful, and durable.

Audit the local control-plane inventory before importing or routing a larger swarm:

```bash
node scripts/agents/agent-os-agent-inventory.mjs summary
node scripts/agents/agent-os-agent-inventory.mjs scan --output .artifacts/agent-os-agent-inventory.json
```

The scan writes an `agent-os.agent-inventory.v1` artifact that separates configured OpenClaw agents, filesystem agents, skill-owned agents, tool adapters, workspace-only entries, native bridge agents, dormant entries, and stale path references. Use that inventory as the import plan; do not flatten every discovered script or skill into `agents.list`.

Build the management plan and catalog after inventory:

```bash
node scripts/agents/agent-os-agent-manager.mjs check
node scripts/agents/agent-os-agent-manager.mjs plan --output .artifacts/agent-os-agent-manager-plan.json
node scripts/agents/agent-os-agent-manager.mjs apply --output .artifacts/agent-os-managed-agents.json
node scripts/agents/agent-os-agent-manager.mjs smoke --all-managed --output .artifacts/agent-os-agent-manager-smoke.json
node scripts/agents/agent-os-agent-purpose-catalog.mjs audit --output .artifacts/agent-os-agent-purpose-catalog.json --format summary
```

The manager writes an `agent-os.agent-manager.v1` catalog and an `agent-os.agent-manager-smoke.v1` control-plane smoke artifact. That proves the repo can discover, classify, route, and contract-smoke managed entries. It does not execute arbitrary local scripts or claim native agent-code execution. Use the delivery proof below for the stronger per-agent route-handler delivery claim.

The purpose catalog reads existing agent definitions, skill frontmatter, skill READMEs, skill-owned agent files, capability profiles, local config, registry entries, and allowlisted local agent metadata such as `IDENTITY.md` and `AGENTS.md`. It writes a purpose-specific task contract for every discovered entry so delivery proof is tied to each agent's own job instead of a generic readiness card.

Run the delivery proof when you need to prove or reject the stronger claim that every discovered entry can deliver:

```bash
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --output .artifacts/agent-os-agent-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --managed-only --require-contract --output .artifacts/agent-os-managed-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --require-live --output .artifacts/agent-os-live-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --require-live --require-purpose --output .artifacts/agent-os-purpose-live-delivery-proof.json --format summary
```

The first command writes a proof result for every discovered entry. The second fails closed unless every selected managed entry has contract-delivery proof. The third fails closed unless every selected entry has live delivery proof through a bounded Agent OS route handler. The fourth also fails closed unless every selected entry has source-backed purpose evidence.

A passing `--require-live` run proves every selected entry accepted an Agent OS ticket, produced an artifact, and emitted proof through its native route or supervised import/quarantine route. It does not prove arbitrary local agent code was executed; proof events include that distinction so stale paths and quarantined surfaces remain visible.

Prove one selected local implementation with the native execution gate:

```bash
node scripts/agents/agent-os-native-exec-proof.mjs prove --agent test_fileio --require-native --output .artifacts/agent-os-native-exec-proof-test_fileio.json --agent-artifacts .artifacts/agent-os-native-exec-proof --format summary
```

Native execution proof runs only the selected local implementation as a host process with a sanitized environment and redacted output. A passing `--require-native` run proves arbitrary native/local code execution for that selected agent only; it does not generalize to every discovered agent and does not prove container isolation.

External framework adapters should target the Agent OS contract rather than bypass it:

- LangGraph graph as a capability agent
- AutoGen team as a capability agent
- CrewAI crew or flow as a capability agent
- OpenHands-style coding worker as a capability agent
- native OpenClaw plugin as a capability agent

Adapters are valuable only when the substrate can still prove ticket lifecycle, sandbox policy, proof events, artifacts, restart recovery, and package inventory.

## Related

- [Capability agents](/tools/capability-agents)
- [Agent OS contract](/reference/agent-os-contract)
- [Security](/gateway/security)
- [Release policy](/reference/RELEASING)
