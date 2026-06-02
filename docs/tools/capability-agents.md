---
summary: "Run native OpenClaw capability agents through Blackboard, signal-hub, and proof events"
read_when:
  - You want to install or inspect native capability agents
  - You are adding a specialist agent that claims Blackboard tickets
  - You are preparing an adapter to run under the Agent OS contract
title: "Capability agents"
---

Capability agents are specialist OpenClaw agents that claim a known family of Blackboard tickets and produce proof artifacts. They are the native reference surface for the Agent OS contract.

Use native capability agents when you want a stable local worker before adding framework adapters.

## Quickstart

Print the built-in capability profiles:

```bash
node scripts/agents/capability-agent-profile.mjs print
```

Inventory every local agent-like surface before importing a larger swarm:

```bash
node scripts/agents/agent-os-agent-inventory.mjs summary
node scripts/agents/agent-os-agent-inventory.mjs scan --output .artifacts/agent-os-agent-inventory.json
```

The inventory uses the `agent-os.agent-inventory.v1` schema and dedupes configured `openclaw.json` agents, `agents_registry.json`, `~/.openclaw/agents`, `~/.openclaw/subagents`, `workspace_*` directories, repo/user skill directories with `SKILL.md`, skill-owned `agents/*.yaml` files, built-in capability profiles, and host-native bridge IDs. It classifies each ID by manageability so the scheduler can distinguish registered agents from tool adapters, skill adapters, dormant references, stale paths, and workspace-only candidates.

Convert the inventory into a management catalog:

```bash
node scripts/agents/agent-os-agent-manager.mjs check
node scripts/agents/agent-os-agent-manager.mjs plan --output .artifacts/agent-os-agent-manager-plan.json
node scripts/agents/agent-os-agent-manager.mjs apply --output .artifacts/agent-os-managed-agents.json
node scripts/agents/agent-os-agent-manager.mjs smoke --all-managed --output .artifacts/agent-os-agent-manager-smoke.json
```

`apply` writes a local catalog artifact; it does not bulk-edit `openclaw.json` or execute discovered scripts. `smoke --all-managed` validates control-plane routing and Agent OS ticket/proof/artifact contracts for registered and adapter-managed entries. Real live delivery remains a separate proof: the selected agent must claim a ticket, run, write artifacts, emit proof events, and finish through the dispatcher or adapter.

Run delivery proof before claiming every agent can work:

```bash
node scripts/agents/agent-os-agent-purpose-catalog.mjs audit --output .artifacts/agent-os-agent-purpose-catalog.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --output .artifacts/agent-os-agent-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --managed-only --require-contract --output .artifacts/agent-os-managed-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --require-live --output .artifacts/agent-os-live-delivery-proof.json --format summary
node scripts/agents/agent-os-agent-delivery-proof.mjs prove --require-live --require-purpose --output .artifacts/agent-os-purpose-live-delivery-proof.json --format summary
```

The purpose catalog binds each discovered entry to a task objective from existing definitions and allowlisted local metadata before delivery proof runs. Contract delivery proves the Agent OS can select the entry, issue a ticket contract, write a proof artifact, and emit an Agent OS proof event. Live delivery runs a bounded route handler for each selected entry; native routes, supervised import routes, and quarantine routes all emit their delivery mode in the proof event. Use `--require-purpose` when every selected entry must have source-backed purpose evidence. Do not market that as arbitrary local agent-code execution unless a separate native executor proof exists for that agent.

Prove arbitrary native/local code execution one selected agent at a time:

```bash
node scripts/agents/agent-os-native-exec-proof.mjs prove --agent test_fileio --require-native --output .artifacts/agent-os-native-exec-proof-test_fileio.json --agent-artifacts .artifacts/agent-os-native-exec-proof --format summary
```

Run the same gate across all native/local candidates:

```bash
node scripts/agents/agent-os-native-exec-proof.mjs prove --all-candidates --output .artifacts/agent-os-native-exec-proof-all.json --agent-artifacts .artifacts/agent-os-native-exec-proof-all --format summary
```

Native execution proof runs selected local implementations as host processes with a sanitized environment and redacted output. It proves `agentCodeExecutionProven: true` only for agents that return `PASS`. `BLOCKED` candidates need direct executable entrypoints, dry-run wrappers, or explicit operator approval before they can be counted as native code execution proof, especially when they touch credentials, accounts, public networks, host installs, local media, or publishing surfaces.

Check whether the profiles are installed in your OpenClaw config:

```bash
node scripts/agents/capability-agent-profile.mjs check --config ~/.openclaw/openclaw.json
```

Apply or refresh the profiles:

```bash
node scripts/agents/capability-agent-profile.mjs apply --config ~/.openclaw/openclaw.json
```

Restart the full-local stack after applying profiles so `signal-hub` can load the updated agent registry:

```bash
pnpm local:full
pnpm local:full:status
```

## Built-in profiles

| Agent                    | Capability family  | Ticket types                                                                                             |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `research_agent`         | `research`         | `research`, `web_research`, `private_search`, `knowledge_search`, `citation_answer`                      |
| `browser_ops_agent`      | `browser-ops`      | `browser_ops`, `browser_task`, `web_automation`, `web_qa`, `browser_e2e`, `ui_qa`                        |
| `security_bouncer_agent` | `security-bouncer` | `security`, `security_event`, `security_incident`, `threat_triage`, `secret_scan`, `dependency_advisory` |

Each profile emits an `agent-os.capability.v1` manifest under `params.agentOsCapability` when applied. That manifest is the stable interface future adapters should target.

## Native agent contract

A native capability agent must:

- declare an `agent-os.capability.v1` manifest
- list at least one `capabilityFamily`
- list the ticket types it can claim
- declare sandbox, network, filesystem, and secret policy
- emit `agent-os.proof-event.v1` proof events
- write artifacts with `agent-os.artifact.v1` metadata when it produces files
- end tickets with a terminal state such as `DONE`, `FAILED`, `BLOCKED`, or `ARCHIVED`

See [Agent OS contract](/reference/agent-os-contract) for the field-level reference.

## Blackboard workflow

The default local flow is:

```text
blackboard-cli post -> signal-hub routes -> agent claims -> agent runs -> proof event -> artifact -> ticket DONE
```

Post a low-impact smoke ticket through the full-local helper:

```bash
pnpm local:full:smoke
```

Run the golden Agent OS E2E when you need packageable proof that tickets, routing, proof contracts, artifact metadata, and restart recovery all work together:

```bash
pnpm local:full:golden
```

The command writes `.artifacts/full-local-agent-os-golden-e2e.json` with an `agent-os.artifact.v1` contract and check results.

Inspect recent tickets for the default host Blackboard:

```bash
node scripts/docker/sidecars/blackboard-cli.cjs list
```

Full-local uses an isolated Blackboard database at `/home/node/.openclaw/full-local/swarm_blackboard.db` by default so boot proofs do not wake old host tickets. Set `SWARM_BLACKBOARD_DB_PATH` when you intentionally want the CLI, signal hub, or a native bridge to share a different ticket database.

Inspect proof:

```bash
node scripts/docker/sidecars/blackboard-cli.cjs proof-list --limit 50
```

## Production readiness

Before adding a new capability agent, decide these boundaries:

- which ticket types it owns
- which tools it can call
- whether it needs network access
- whether it can write to the workspace
- which secrets it can reference
- which actions require approval
- which proof bundle demonstrates success
- how it recovers from restart or timeout

Full-local keeps the Sentinel, Gateway, bridge, and Teams host ports published on `127.0.0.1` by default, requires a Sentinel token for model proxy requests, and leaves health endpoints unauthenticated for orchestration.

Set `OPENCLAW_FULL_LOCAL_ALLOW_LAN_PUBLISH=1` with overrides such as `OPENCLAW_GATEWAY_PUBLISH=0.0.0.0:18789:18789`, `OPENCLAW_BRIDGE_PUBLISH=0.0.0.0:18790:18790`, or `OPENCLAW_MSTEAMS_PUBLISH=0.0.0.0:3978:3978` only when you intentionally expose those ports beyond loopback. Existing host-only overrides such as `OPENCLAW_GATEWAY_PUBLISH_HOST=0.0.0.0` require the same allow flag when the full publish mapping is unset. The Windows native bridge only dispatches explicitly configured native agents and records host-native dispatch attempts into `proof_events` so native work has the same audit trail as container work.

Direct Sentinel runs also refuse unauthenticated non-loopback binds unless `OPENCLAW_SENTINEL_ALLOW_UNAUTHENTICATED_LAN=1` is set. Prefer token-authenticated Sentinel when any network beyond loopback can reach it.

Prefer a narrow native agent first. Add external framework adapters only after the native contract is stable.

## Related

- [Agent OS contract](/reference/agent-os-contract)
- [Subagents](/tools/subagents)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
