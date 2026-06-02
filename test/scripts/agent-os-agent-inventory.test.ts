import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_AGENT_INVENTORY_SCHEMA_VERSION,
  collectAgentInventory,
  runAgentInventoryCli,
} from "../../scripts/agents/agent-os-agent-inventory.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

describe("agent os agent inventory", () => {
  it("dedupes configured, registry, filesystem, skill, and native bridge agents", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-agent-inventory-"));
    const repoRoot = path.join(root, "repo");
    const openclawHome = path.join(root, ".openclaw");
    try {
      mkdirSync(path.join(openclawHome, "agents", "main"), { recursive: true });
      mkdirSync(path.join(openclawHome, "agents", "orphan_agent"), { recursive: true });
      mkdirSync(path.join(openclawHome, "workspace_main"), { recursive: true });
      mkdirSync(path.join(openclawHome, "workspace_workspace_only"), { recursive: true });
      mkdirSync(path.join(root, "tools"), { recursive: true });
      writeText(path.join(root, "tools", "upload.py"), "print('ok')\n");

      writeJson(path.join(openclawHome, "openclaw.json"), {
        agents: {
          list: [
            {
              default: true,
              id: "main",
              name: "Main Agent",
              workspace: path.join(openclawHome, "workspace_main"),
            },
            {
              id: "research_agent",
              params: {
                agentOsCapability: {
                  capabilityFamilies: ["research"],
                  ticketTypes: ["research", "web_research"],
                },
              },
              skills: ["semantic-code-retrieval"],
            },
          ],
        },
      });
      writeJson(path.join(openclawHome, "agents_registry.json"), {
        agents: [
          {
            id: "main",
            path: path.join(openclawHome, "agents", "main"),
            status: "listed",
            type: "orchestrator",
          },
          {
            id: "upload_tool",
            path: path.join(root, "tools", "upload.py"),
            status: "unlisted",
            type: "python_tool",
          },
          {
            id: "missing_tool",
            path: path.join(root, "missing.py"),
            status: "unlisted",
            type: "python_tool",
          },
          {
            id: "dormant_partner",
            path: path.join(root, "missing-partner"),
            status: "dormant",
            type: "business_agent",
          },
        ],
      });
      writeText(
        path.join(repoRoot, ".agents", "skills", "discrawl", "agents", "openai.yaml"),
        "id: discrawl_worker\nname: Discrawl Worker\n",
      );
      writeText(
        path.join(
          repoRoot,
          ".agents",
          "skills",
          "technical-documentation",
          "agents",
          "inventory-agent.md",
        ),
        "---\nname: inventory-agent\ndescription: Fast repo-surface discovery for docs audits.\n---\n",
      );
      writeText(path.join(repoRoot, "skills", "weather", "SKILL.md"), "# weather\n");
      writeText(
        path.join(openclawHome, "skills", "developer-agency-enhanced", "SKILL.md"),
        "# developer agency\n",
      );
      writeText(
        path.join(repoRoot, ".agents", "skills", "swarm-signal", "scripts", "signal_hub.cjs"),
        "const NATIVE_AGENTS = new Set(['native_agent']);\n",
      );
      writeText(
        path.join(repoRoot, "scripts", "agents", "capability-agent-profile.mjs"),
        "export const x = [{ id: 'research_agent' }, { id: 'security_bouncer_agent' }];\n",
      );

      const inventory = collectAgentInventory({ openclawHome, repoRoot });
      expect(inventory.schemaVersion).toBe(AGENT_OS_AGENT_INVENTORY_SCHEMA_VERSION);
      expect(inventory.summary.totalUnique).toBe(13);
      expect(inventory.summary.registered).toBe(2);
      expect(inventory.summary.byManageability).toMatchObject({
        "adapter-manageable": 3,
        "adapter-stale": 1,
        "discoverable-not-registered": 6,
        "dormant-stale": 1,
        registered: 2,
      });

      const byId = new Map(inventory.agents.map((agent) => [agent.id, agent]));
      expect(byId.get("main")).toMatchObject({
        kinds: expect.arrayContaining(["default-agent", "openclaw-agent", "registry-agent"]),
        manageability: "registered",
        registered: true,
      });
      expect(byId.get("research_agent")).toMatchObject({
        capabilityFamilies: ["research"],
        kinds: expect.arrayContaining(["capability-agent", "capability-profile"]),
        ticketTypes: ["research", "web_research"],
      });
      expect(byId.get("upload_tool")).toMatchObject({
        kinds: ["tool-adapter"],
        manageability: "adapter-manageable",
      });
      expect(byId.get("missing_tool")).toMatchObject({
        manageability: "adapter-stale",
        warnings: expect.arrayContaining(["path reference missing", "registry path missing"]),
      });
      expect(byId.get("discrawl_worker")).toMatchObject({
        kinds: ["skill-owned-agent"],
        skills: ["discrawl"],
      });
      expect(byId.get("inventory-agent")).toMatchObject({
        displayName: "inventory-agent",
        kinds: ["skill-owned-agent"],
        skills: ["technical-documentation"],
      });
      expect(byId.get("native_agent")).toMatchObject({
        kinds: ["host-native-agent"],
      });
      expect(byId.get("weather")).toMatchObject({
        kinds: ["skill-adapter"],
        manageability: "adapter-manageable",
      });
      expect(byId.get("workspace_only")).toMatchObject({
        kinds: ["workspace"],
        manageability: "discoverable-not-registered",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prints a summary and can write the scan artifact", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-agent-inventory-cli-"));
    const repoRoot = path.join(root, "repo");
    const openclawHome = path.join(root, ".openclaw");
    const outputPath = path.join(root, "inventory.json");
    try {
      writeJson(path.join(openclawHome, "openclaw.json"), {
        agents: { list: [{ id: "main" }] },
      });
      expect(
        runAgentInventoryCli([
          "scan",
          "--repo",
          repoRoot,
          "--openclaw-home",
          openclawHome,
          "--output",
          outputPath,
        ]),
      ).toBe(0);
      const written = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(written.summary.totalUnique).toBe(1);
      expect(written.agents[0]).toMatchObject({ id: "main", registered: true });

      expect(
        runAgentInventoryCli(["summary", "--repo", repoRoot, "--openclaw-home", openclawHome]),
      ).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
